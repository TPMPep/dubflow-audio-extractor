/* eslint-env node */
/* eslint-disable no-undef */
// =============================================================================
// semaphore.js — Bounded FFmpeg concurrency gate for the audio extractor.
// -----------------------------------------------------------------------------
// THE STRUCTURAL CURE for the 2026-07-31 "extractor goes down after a bit"
// incident. Root cause: the service accepted UNLIMITED simultaneous heavy
// FFmpeg jobs. Four BullMQ worker replicas each firing proxy-gen / mix / mux
// jobs at once = N concurrent full-video transcodes pinning every CPU core, so
// even /health couldn't get a timeslice and Railway's edge returned 499/502.
// Restart → workers re-fire → re-saturate. The service was healthy; it had NO
// admission control.
//
// This gate makes that class of failure STRUCTURALLY IMPOSSIBLE with THREE
// independent lanes, so each workload class has its own guaranteed capacity and
// none can starve another (SOC 2 CC7.4 — bounded, provable-from-config load):
//   • HEAVY routes (proxy-gen, mix, mux, extract, hls-ingest, burn-subtitles)
//     acquire a slot from a bounded pool (MAX_HEAVY, default 3). These are the
//     CPU-bound full-media FFmpeg transcodes. Excess requests WAIT in a FIFO
//     queue instead of all running at once, so the box always keeps CPU headroom
//     for the Node loop + the other lanes + /health, and can never wedge.
//   • SCAN route (hash-file) has its OWN dedicated pool (MAX_SCAN, default 6).
//     This is the malware-gate SHA-256 — an I/O-bound streaming read of the
//     source object (can be multi-GB ProRes; ~55 ms/MB, so ~80–125 s on a
//     540 MB file). It is DELIBERATELY isolated because (a) it is a SECURITY
//     CONTROL that must never be starved by render work — the scan gate always
//     has guaranteed slots — and (b) it is I/O-bound, not CPU-bound, so it can
//     safely run at higher concurrency than heavy transcodes without pinning
//     cores. Keeping it off the light lane also means a burst of large-file
//     scans (100 users uploading at once) can never starve fast interactive
//     clip ops, and heavy transcodes can never starve the scan.
//   • LIGHT routes (trim, silence-detect, process, time-stretch, normalize,
//     concat) run on a SEPARATE pool (MAX_LIGHT, default 6) — quick interactive
//     clip ops (voice previews, trims) that must stay snappy regardless of what
//     the heavy or scan lanes are doing.
//   • /health NEVER acquires anything — it must always answer instantly, which
//     is exactly what proves the box is alive.
//
// The cap is per-REPLICA. This service runs a single replica (24 vCPU / 24 GB,
// US-West). MAX_HEAVY=3 CPU-bound transcodes + MAX_SCAN=6 I/O-bound streams +
// MAX_LIGHT=6 short clip ops still leaves ample vCPU headroom for the Node loop
// and /health, because scans are I/O-bound (they idle on S3 throughput, not
// CPU). All tunable via env without a code change:
//   EXTRACTOR_MAX_HEAVY (default 3), EXTRACTOR_MAX_SCAN (default 6),
//   EXTRACTOR_MAX_LIGHT (default 6).
//
// A request that waits longer than ACQUIRE_TIMEOUT_MS (default 10 min) for a
// slot fails fast with 503 rather than hanging forever — a bounded, honest
// backpressure signal the caller's retry policy can act on. SOC 2 CC7.4 —
// subprocessor/host load is bounded and provable from config alone.
//
// Zero dependencies: a plain in-process counting semaphore with a FIFO waiter
// queue. Per-replica, in-memory (no Redis) — correct because the cap is a
// per-container CPU-protection limit, not a global business invariant.
// =============================================================================

function makeSemaphore(max, label) {
  let inFlight = 0;
  const waiters = []; // FIFO queue of { resolve, timer }

  function _tryNext() {
    if (waiters.length === 0 || inFlight >= max) return;
    const next = waiters.shift();
    clearTimeout(next.timer);
    inFlight += 1;
    next.resolve();
  }

  // Acquire a slot. Resolves when a slot is free; rejects if the wait exceeds
  // timeoutMs (fail-fast backpressure). Returns a release() the caller MUST
  // call in a finally block.
  function acquire(timeoutMs) {
    return new Promise((resolve, reject) => {
      if (inFlight < max) {
        inFlight += 1;
        resolve(_makeRelease());
        return;
      }
      const waiter = {
        resolve: () => resolve(_makeRelease()),
        timer: setTimeout(() => {
          const idx = waiters.indexOf(waiter);
          if (idx !== -1) waiters.splice(idx, 1);
          reject(new Error(`${label} semaphore: timed out after ${Math.round(timeoutMs / 1000)}s waiting for a slot (${inFlight}/${max} busy)`));
        }, timeoutMs),
      };
      waiters.push(waiter);
    });
  }

  function _makeRelease() {
    let released = false;
    return function release() {
      if (released) return;
      released = true;
      inFlight -= 1;
      if (inFlight < 0) inFlight = 0;
      _tryNext();
    };
  }

  function stats() { return { label, max, in_flight: inFlight, waiting: waiters.length }; }

  return { acquire, stats };
}

const MAX_HEAVY = Math.max(1, Number(process.env.EXTRACTOR_MAX_HEAVY || 3));
const MAX_SCAN = Math.max(1, Number(process.env.EXTRACTOR_MAX_SCAN || 6));
const MAX_LIGHT = Math.max(1, Number(process.env.EXTRACTOR_MAX_LIGHT || 6));
// Slot-wait ceilings, per lane. Heavy/light fail fast (10 min) — a caller
// waiting that long for a render/clip op should get honest backpressure and
// retry. SCAN waits longer (20 min): a large-file hash IS the malware-gate's
// critical path, so we'd rather queue it than 503 the security scan and force a
// full re-scan cycle. Still bounded — it can never hang forever.
const ACQUIRE_TIMEOUT_MS = 10 * 60 * 1000;
const SCAN_ACQUIRE_TIMEOUT_MS = 20 * 60 * 1000;

const heavySemaphore = makeSemaphore(MAX_HEAVY, "heavy");
const scanSemaphore = makeSemaphore(MAX_SCAN, "scan");
const lightSemaphore = makeSemaphore(MAX_LIGHT, "light");

// Routes that spawn a real FFmpeg full-media transcode (CPU-bound, minutes).
const HEAVY_PATHS = new Set([
  "/generate-proxy-sync",
  "/mix-final",
  "/mux-video",
  "/extract",
  "/hls-ingest",
  "/burn-subtitles",
]);

// The malware-gate streaming hash — its own dedicated, never-starvable lane.
const SCAN_PATHS = new Set([
  "/hash-file",
]);

// Resolve the correct lane + slot-wait ceiling for a path. HEAVY → heavy pool,
// SCAN → dedicated scan pool (longer ceiling), everything else → light pool.
function laneFor(path) {
  if (HEAVY_PATHS.has(path)) return { sem: heavySemaphore, timeoutMs: ACQUIRE_TIMEOUT_MS };
  if (SCAN_PATHS.has(path)) return { sem: scanSemaphore, timeoutMs: SCAN_ACQUIRE_TIMEOUT_MS };
  return { sem: lightSemaphore, timeoutMs: ACQUIRE_TIMEOUT_MS };
}

// Wrap a route handler so it acquires the correct lane before running and
// always releases after. /health is never wrapped (handled in index.js). On
// slot-wait timeout we return 503 (retryable) instead of hanging.
function withConcurrencyGate(path, handler) {
  const { sem, timeoutMs } = laneFor(path);
  return async function gatedHandler(req, res, API_KEY) {
    let release;
    try {
      release = await sem.acquire(timeoutMs);
    } catch (waitErr) {
      // Never got a slot in time — the box is saturated. Honest backpressure.
      if (!res.headersSent) {
        res.writeHead(503, { "Content-Type": "application/json", "Retry-After": "30" });
        res.end(JSON.stringify({ error: "extractor_busy", message: waitErr.message }));
      }
      return;
    }
    try {
      return await handler(req, res, API_KEY);
    } finally {
      release();
    }
  };
}

function semaphoreStats() {
  return { heavy: heavySemaphore.stats(), scan: scanSemaphore.stats(), light: lightSemaphore.stats() };
}

module.exports = { withConcurrencyGate, semaphoreStats, HEAVY_PATHS, SCAN_PATHS };

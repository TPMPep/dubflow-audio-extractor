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
// This gate makes that class of failure STRUCTURALLY IMPOSSIBLE:
//   • HEAVY routes (proxy-gen, mix, mux, extract, hls-ingest, burn-subtitles)
//     acquire a slot from a bounded pool (MAX_HEAVY, default 3). Excess
//     requests WAIT in a FIFO queue instead of all running at once. The box
//     always keeps headroom for /health + light work, so it can never wedge.
//   • LIGHT routes (trim, silence-detect, process, time-stretch, normalize,
//     concat, hash-file) run on a SEPARATE, higher pool (MAX_LIGHT, default 6)
//     so a heavy backlog can never block a quick voice preview / trim.
//   • /health NEVER acquires anything — it must always answer instantly, which
//     is exactly what proves the box is alive.
//
// The cap is per-REPLICA. This service runs a single replica (24 vCPU / 24 GB,
// US-West), so MAX_HEAVY=3 leaves ~15+ vCPU of headroom for the Node loop,
// light lane, and health. Tunable via env without a code change:
//   EXTRACTOR_MAX_HEAVY (default 3), EXTRACTOR_MAX_LIGHT (default 6).
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
const MAX_LIGHT = Math.max(1, Number(process.env.EXTRACTOR_MAX_LIGHT || 6));
const ACQUIRE_TIMEOUT_MS = 10 * 60 * 1000; // 10 min — fail fast rather than hang.

const heavySemaphore = makeSemaphore(MAX_HEAVY, "heavy");
const lightSemaphore = makeSemaphore(MAX_LIGHT, "light");

// Routes that spawn a real FFmpeg full-media transcode (CPU-bound, minutes).
// Everything else that touches FFmpeg is a short clip op on the light lane.
const HEAVY_PATHS = new Set([
  "/generate-proxy-sync",
  "/mix-final",
  "/mux-video",
  "/extract",
  "/hls-ingest",
  "/burn-subtitles",
]);

// Wrap a route handler so it acquires the correct lane before running and
// always releases after. /health is never wrapped (handled in index.js). On
// slot-wait timeout we return 503 (retryable) instead of hanging.
function withConcurrencyGate(path, handler) {
  const sem = HEAVY_PATHS.has(path) ? heavySemaphore : lightSemaphore;
  return async function gatedHandler(req, res, API_KEY) {
    let release;
    try {
      release = await sem.acquire(ACQUIRE_TIMEOUT_MS);
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
  return { heavy: heavySemaphore.stats(), light: lightSemaphore.stats() };
}

module.exports = { withConcurrencyGate, semaphoreStats, HEAVY_PATHS };

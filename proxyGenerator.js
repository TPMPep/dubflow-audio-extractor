/* eslint-env node */
/* eslint-disable no-undef */
// proxyGenerator.js — v2 SYNCHRONOUS proxy generation (2026-05-14).
//
// Replaces the legacy fire-and-forget /generate-proxy + webhook callback
// architecture with the same synchronous pattern hlsIngest.js uses. The
// BullMQ worker (bullmq-worker/src/processors/proxy-gen.ts) holds this
// HTTP connection open for up to 3.5hr, heartbeats its job lock every 15s,
// and finalizes the Project entity via proxyGenWorkerStep after we return.
//
// Why the rewrite:
// The legacy /generate-proxy returned 202 + ran execSync in the background
// + POSTed a callback back to Base44 when done. Three failure modes:
//   1. execSync starved Node's event loop — /health couldn't answer mid-
//      transcode (Base44's diagnostic probe saw HTTP 30s aborts).
//   2. The 202 response and the ffmpeg kickoff raced on the socket buffer
//      flush — callers timed out before seeing the 202.
//   3. The webhook callback (proxyGenerationCallback) had no retries, no
//      observability, no DLQ — a dropped callback left the Project
//      stuck in 'generating' forever.
//
// New endpoint: POST /generate-proxy-sync
//   • Synchronous reply on the SAME connection (no 202, no callback).
//   • The worker holds the connection (long-timeout fetch + lock heartbeat).
//   • NON-BLOCKING async spawn: stderr/stdout/exit-code/signal are ALL captured
//     even on failure, WITHOUT freezing the Node event loop for the transcode.
//     Keeps /health responsive while a long proxy transcode runs. The prior
//     spawnSync design blocked the single-threaded event loop for the whole
//     transcode, so one stuck proxy pinned the loop and the box appeared to
//     "die after a bit". async spawn cures that at the root.
//   • STREAMING S3 upload: the finished proxy streams from disk → S3 with a
//     bounded ~64KB memory footprint (putS3ObjectStreaming). The old
//     readFileSync + putS3Object loaded the ENTIRE proxy (hundreds of MB for a
//     broadcast master) into RAM three times over — the dominant OOM source.
//   • HEAVY-LANE FAST-503 GATE: a bounded semaphore caps concurrent heavy proxy
//     transcodes (default 2, EXTRACTOR_MAX_PROXY). When full it returns HTTP 503
//     IMMEDIATELY (Retry-After) and the BullMQ worker retries with backoff — no
//     held-open connection, so Cloudflare 524s are structurally impossible. This
//     is the FAST-503 design, NOT the reverted long-acquire-wait queue. Together
//     the streaming upload + the gate end the OOM → SIGKILL → 502 death spiral
//     that concurrent ProRes masters triggered.
//
// The legacy /generate-proxy route is DELETED. Any caller still using it
// gets a clean 404 — easier to detect + fix than a silent compatibility
// shim. Base44's generateProxy function has been rewritten to call the
// BullMQ worker instead of this endpoint directly.

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

// ── Async, NON-BLOCKING ffmpeg/ffprobe runner (SOC 2 CC7.2) ──────────────────
// The 2026-07-31 root fix for proxy-gen: spawnSync BLOCKS the single-threaded
// Node event loop for the ENTIRE transcode (up to 3.5hr). While one proxy job
// grinds, the whole service stalls — /health included — which is exactly the
// "works after restart, dies after a bit" wedge (one stuck proxy pinned the
// loop). spawn() runs the child WITHOUT blocking the loop, so the service stays
// responsive during a long transcode. Resolves { status, signal, stdout, stderr } on exit;
// rejects only on spawn failure (ENOENT) or the hard timeout SIGKILL.
function runProcess(bin, args, { timeoutMs, maxOutputBytes = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = timeoutMs ? setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch (_) { /* already gone */ }
      resolve({ status: null, signal: "SIGTERM", stdout, stderr, timedOut: true });
    }, timeoutMs) : null;
    // Drain BOTH pipes so a chatty child never back-pressures and deadlocks
    // (the classic spawn pitfall). Cap retained output so a runaway log can't
    // balloon memory — ffmpeg errors live in the last few KB anyway.
    child.stdout.on("data", (d) => { if (stdout.length < maxOutputBytes) stdout += d.toString(); });
    child.stderr.on("data", (d) => { if (stderr.length < maxOutputBytes) stderr += d.toString(); });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(err); // ENOENT (bin missing) etc.
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ status: code, signal, stdout, stderr, timedOut: false });
    });
  });
}

// ── Source metadata probe (ffprobe) ─────────────────────────────────────────
// One remote probe returns BOTH authoritative duration and frame rate. Duration
// is required before whole-program language sampling; persisting it here removes
// the scan-clean race that previously collapsed preflight to the opening minute.
async function probeSourceMetadata(sourceUrl) {
  try {
    const probe = await runProcess("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "format=duration:stream=r_frame_rate",
      "-of", "json",
      sourceUrl,
    ], { timeoutMs: 60_000 });
    if (probe.status !== 0) return { frame_rate: null, duration_ms: null };
    const parsed = JSON.parse(String(probe.stdout || "{}"));
    const rawRate = String(parsed?.streams?.[0]?.r_frame_rate || "");
    const match = rawRate.match(/^(\d+)\/(\d+)$/);
    const fps = match && Number(match[2]) > 0
      ? Number(match[1]) / Number(match[2])
      : Number(rawRate);
    const durationSec = Number(parsed?.format?.duration);
    return {
      frame_rate: Number.isFinite(fps) && fps > 0 && fps <= 240
        ? Math.round(fps * 1000) / 1000
        : null,
      duration_ms: Number.isFinite(durationSec) && durationSec > 0
        ? Math.round(durationSec * 1000)
        : null,
    };
  } catch {
    return { frame_rate: null, duration_ms: null };
  }
}
// Zero-dependency WebCrypto SigV4 signer (replaces @aws-sdk/@smithy — incident
// 2026-07-07/08). STS session-token aware. See ./s3-signer.js.
const { putS3ObjectStreaming, createSemaphore, storageFromEnv } = require("./s3-signer");

// ── Heavy-lane concurrency gate (FAST-503) ───────────────────────────────────
// Proxy generation is the single most memory-heavy route: decoding a broadcast
// master (ProRes/DNx 10-bit 4:2:2) + encoding a 720p H.264 proxy + a FLAC audio
// proxy, all at once, is the dominant OOM source. Cap concurrent heavy proxy
// transcodes so N of them can never OOM the container simultaneously. Default 2
// (tunable via EXTRACTOR_MAX_PROXY without a redeploy) — comfortably safe on the
// 24-vCPU box while still processing two proxies in parallel. When the lane is
// full we return HTTP 503 IMMEDIATELY (no held-open connection, no 524 risk);
// the BullMQ worker retries with its own exponential backoff. SOC 2 CC7.2.
const PROXY_SEMAPHORE = createSemaphore(
  Math.max(1, Math.min(6, Number(process.env.EXTRACTOR_MAX_PROXY) || 2)),
);

async function handleProxyGenSync(req, res, API_KEY) {
  const t0 = Date.now();
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString()); }
  catch { res.writeHead(400); return res.end(JSON.stringify({ error: "bad JSON" })); }

  // Same auth pattern as /hls-ingest and /generate-proxy (legacy).
  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.replace("Bearer ", "");
  if (token !== API_KEY && body.api_key !== API_KEY) {
    res.writeHead(401);
    return res.end(JSON.stringify({ error: "Unauthorized" }));
  }

  const required = ["project_id", "source_url", "bucket", "region", "proxy_video_key", "proxy_audio_key"];
  for (const k of required) {
    if (!body[k]) {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: `${k} required` }));
    }
  }

  const {
    project_id,
    source_url,
    bucket,
    region,
    proxy_video_key,
    proxy_audio_key,
    credential_secret_prefix = "",
  } = body;

  // Extract source host (no signature / no query) for redacted audit logging.
  const sourceHost = (() => {
    try { return new URL(source_url).host; } catch { return "unparseable"; }
  })();

  // ── Acquire a heavy-lane slot (FAST-503) ──
  // All validation above is cheap and slot-free. Only the memory-heavy
  // transcode below consumes a slot. If the lane is full, return 503 NOW so the
  // worker retries with backoff — never hold this connection open waiting (that
  // was the reverted gate's 524 bug). SOC 2 CC7.2.
  if (!PROXY_SEMAPHORE.tryAcquire()) {
    console.warn(`[generate-proxy-sync] ${project_id} heavy lane full (${PROXY_SEMAPHORE.inUse()}/${PROXY_SEMAPHORE.max}) — returning 503 for worker retry`);
    res.writeHead(503, { "Content-Type": "application/json", "Retry-After": "30" });
    return res.end(JSON.stringify({
      error: "proxy_lane_busy",
      message: `Heavy transcode lane full (${PROXY_SEMAPHORE.inUse()}/${PROXY_SEMAPHORE.max}). Retry shortly.`,
      project_id,
      retryable: true,
    }));
  }

  // tmpDir creation is INSIDE the try so that a mkdtempSync failure (e.g. disk
  // full) after tryAcquire() still hits the finally that releases the slot — a
  // slot leaked on a rare pre-transcode throw would permanently shrink capacity.
  let tmpDir = null;
  const videoName = "proxy.mp4";
  const audioName = "proxy.flac";

  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `proxy-${project_id}-`));
    const videoPath = path.join(tmpDir, videoName);
    const audioPath = path.join(tmpDir, audioName);
    console.log(`[generate-proxy-sync] ${project_id} starting`, {
      source_host: sourceHost,
      bucket,
      region,
      video_target: proxy_video_key,
      audio_target: proxy_audio_key,
    });

    // ────────────────────────────────────────────────────────────────────
    // Single ffmpeg pass producing both proxies — only decodes source once.
    // Args array (NOT shell string) so spawnSync can capture stderr cleanly
    // and we don't have shell-quoting issues with signed URLs.
    // ────────────────────────────────────────────────────────────────────
    // ── PRO-CODEC MASTER HARDENING (2026-07-31) ───────────────────────────
    // Broadcast masters arrive as ProRes 422 (HQ), DNxHD/DNxHR, and other
    // pro intermediates — NOT web-friendly H.264. Two things about these
    // sources break a naive proxy transcode, and both are fixed HERE so the
    // whole ingest path is correct for professional media, not just a one-off
    // patch for a single file:
    //
    //   1. DECODER THREAD-INIT FAILURE (the actual failure we hit):
    //      "Error while opening decoder for input stream #0:0 : Resource
    //      temporarily unavailable" is FFmpeg's ProRes/DNx decoder failing to
    //      spin up its default auto-thread pool inside a constrained Railway
    //      container. Forcing single-threaded DECODE init (`-threads 1` BEFORE
    //      `-i`) makes the decoder open deterministically. This is an
    //      input/decode-side flag — it does NOT slow the H.264 ENCODE (that
    //      still uses libx264's own threading).
    //
    //   2. 10-bit 4:2:2 PIXEL FORMAT:
    //      ProRes 422 is 10-bit 4:2:2. Standard-profile H.264 (libx264) cannot
    //      encode 4:2:2/10-bit without an explicit downconvert — even once the
    //      decoder opens, the encode would fail. `format=yuv420p` in the filter
    //      chain normalizes every pro source to the 8-bit 4:2:0 the 720p editor
    //      proxy needs. Web-friendly H.264 sources are already yuv420p, so this
    //      is a no-op for them — safe for EVERY source, not just ProRes.
    //
    // `-fflags +genpts` + `-err_detect ignore_err` keep a master with benign
    // container quirks (missing PTS on an intermediate, a non-fatal stream
    // error) from aborting the whole transcode. `-map 0:v:0? / 0:a:0?` already
    // tolerate absent streams. Net effect: pro broadcast masters proxy
    // reliably, and nothing about the H.264/web-source path changes.
    const ffmpegArgs = [
      "-hide_banner", "-loglevel", "error",
      // Decode-side hardening (BEFORE -i): deterministic decoder init +
      // tolerant demux for pro-codec / intermediate masters.
      "-threads", "1",
      "-fflags", "+genpts",
      "-err_detect", "ignore_err",
      "-i", source_url,
      // Video proxy: 720p H.264 ~2 Mbps, AAC 128k stereo.
      // format=yuv420p downconverts 10-bit 4:2:2 ProRes/DNx to the 8-bit 4:2:0
      // H.264 the editor proxy needs (no-op for already-yuv420p sources).
      "-map", "0:v:0?", "-map", "0:a:0?",
      "-c:v", "libx264", "-preset", "fast",
      "-b:v", "2M", "-maxrate", "2.5M", "-bufsize", "4M",
      "-vf", "scale=-2:720,format=yuv420p",
      "-c:a", "aac", "-b:a", "128k", "-ac", "2",
      "-movflags", "+faststart",
      "-f", "mp4", videoPath,
      // Audio proxy: 16 kHz mono FLAC for AssemblyAI / Replicate
      "-map", "0:a:0?", "-vn", "-ac", "1", "-ar", "16000",
      "-c:a", "flac", "-f", "flac", audioPath,
    ];

    // NON-BLOCKING spawn (2026-07-31). runProcess drains stdout/stderr as
    // strings and captures exit code + signal EVEN on failure — same legible
    // observability as the old spawnSync, but WITHOUT freezing the event loop
    // for the whole transcode. A spawn-level failure (ENOENT: ffmpeg missing)
    // rejects and is caught by the outer try/catch below as a 500. A hard
    // timeout resolves with timedOut=true + signal 'SIGTERM'.
    const result = await runProcess("ffmpeg", ffmpegArgs, {
      timeoutMs: 3.5 * 60 * 60 * 1000,
    });

    if (result.status !== 0 || result.signal) {
      const stderr = (result.stderr || "").toString();
      const stdout = (result.stdout || "").toString();
      const diagnostic = {
        exit_code: result.status,                              // null if killed by signal
        signal: result.signal,                                 // SIGKILL=OOM, SIGTERM=timeout
        timed_out: result.timedOut || false,                   // hard 3.5hr ceiling hit
        stderr_tail: stderr.slice(-2000) || "(empty)",
        stdout_tail: stdout.slice(-500) || "(empty)",
        source_host: sourceHost,
        // Redacted argv — replace the full signed URL with just its host
        // so the audit trail proves what we invoked without leaking the
        // signature. (SOC 2 CC6.x — secrets never appear in logs.)
        ffmpeg_argv: ffmpegArgs.map(a => (typeof a === "string" && a.startsWith("http")) ? `<url:${sourceHost}>` : a),
        duration_ms: Date.now() - t0,
      };
      console.error(`[generate-proxy-sync] ${project_id} ffmpeg failed`, diagnostic);
      try { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      // 4xx → worker's UnrecoverableError → no retry, straight to DLQ.
      // ffmpeg non-zero exit is deterministic; retrying wastes another
      // 5-15min of compute and produces an identical failure row.
      res.writeHead(422, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        error: "proxy_gen_failed",
        message: `ffmpeg exit=${result.status} signal=${result.signal || "none"}: ${diagnostic.stderr_tail.slice(-800)}`,
        project_id,
        diagnostic,
      }));
    }

    // Probe source truth once: duration drives whole-program preflight sampling;
    // frame rate drives frame-counted caption exports.
    const sourceMetadata = await probeSourceMetadata(source_url);

    const storage = storageFromEnv({ region, bucket, prefix: credential_secret_prefix });
    // STREAMING uploads — never load the proxy into RAM (the OOM cure). Each
    // proxy streams from disk → S3 with a bounded ~64KB footprint regardless of
    // file size. Sizes are read from fs.stat (in putS3ObjectStreaming), not by
    // buffering the file. Run sequentially: two large concurrent stream-uploads
    // still each hold only a small buffer, but sequential keeps peak network +
    // fd usage predictable on the shared box.
    const videoRes = await putS3ObjectStreaming(storage, proxy_video_key, videoPath, { contentType: "video/mp4" });
    const audioRes = await putS3ObjectStreaming(storage, proxy_audio_key, audioPath, { contentType: "audio/flac" });
    const videoBytes = videoRes.bytes;
    const audioBytes = audioRes.bytes;

    const durationMs = Date.now() - t0;
    console.log(
      `[generate-proxy-sync] ${project_id} ready ` +
      `(video ${(videoBytes / 1024 / 1024).toFixed(0)}MB, ` +
      `audio ${(audioBytes / 1024 / 1024).toFixed(0)}MB, ` +
      `duration ${durationMs}ms)`
    );

    fs.rmSync(tmpDir, { recursive: true, force: true });

    // ─── Synchronous reply — worker is holding the connection. ───
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      proxy_video_key,
      proxy_audio_key,
      bytes_video: videoBytes,
      bytes_audio: audioBytes,
      duration_ms: durationMs,
      // Machine-measured source frame rate (null if the probe failed). The
      // finalizer writes it to Project.frame_rate with frame_rate_source='ffprobe'.
      source_frame_rate: sourceMetadata.frame_rate,
      source_duration_ms: sourceMetadata.duration_ms,
      project_id,
    }));
  } catch (err) {
    console.error(`[generate-proxy-sync] ${project_id} fatal:`, err.message, err.stack);
    try { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    // 5xx → worker retries per BullMQ PROXY_GEN_JOB_OPTIONS (attempts=6, so
    // transient/lane-busy cases get ample backoff headroom). Transient here:
    // S3 5xx, network blip, ENOENT on tmp.
    res.writeHead(500);
    return res.end(JSON.stringify({
      error: "proxy_gen_failed",
      message: String(err.message || err).slice(0, 1000),
      project_id,
    }));
  } finally {
    // ALWAYS release the heavy-lane slot — success, ffmpeg failure, or fatal.
    // A leaked slot would permanently shrink capacity and eventually wedge the
    // lane. This finally is the single release point paired with the tryAcquire
    // above. SOC 2 CC7.2.
    PROXY_SEMAPHORE.release();
  }
}

// Route descriptor — registered once in index.js's single route table.
const routeProxyGen = { method: "POST", path: "/generate-proxy-sync", handler: handleProxyGenSync };

module.exports = { routeProxyGen };

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
//   • spawnSync with stdio piped: stderr/stdout/exit-code/signal are ALL
//     captured even on failure. Node is single-purpose per request: the
//     worker is the only caller, only one job runs at a time on this dyno
//     (CONCURRENCY_PROXY_GEN=1), and the worker holds the connection so
//     /health responsiveness is no longer the success criterion.
//
// The legacy /generate-proxy route is DELETED. Any caller still using it
// gets a clean 404 — easier to detect + fix than a silent compatibility
// shim. Base44's generateProxy function has been rewritten to call the
// BullMQ worker instead of this endpoint directly.

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

// ── True frame-rate probe (ffprobe) ──────────────────────────────────────────
// The authoritative, machine-MEASURED frame rate of the source video. This is
// the enterprise root fix for the SCC frame-rate problem: Project.frame_rate was
// historically an operator-entered / defaulted number (83% sat at the schema
// default of 25), so SCC timecodes — which are frame-COUNTED — could be divided
// by a value nobody verified. ffprobe is already in the ffmpeg image (zero new
// dependency); we read r_frame_rate ("24000/1001") and evaluate the rational to
// a float (23.976). Best-effort: any failure returns null so the finalizer keeps
// the existing value rather than overwriting truth with a worse guess. SOC 2
// CC8.1 — a measured fps is provably distinct from a defaulted one.
function probeSourceFrameRate(sourceUrl) {
  try {
    const probe = spawnSync("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=r_frame_rate",
      "-of", "default=noprint_wrappers=1:nokey=1",
      sourceUrl,
    ], { timeout: 60_000, maxBuffer: 1024 * 1024, encoding: "utf8" });
    if (probe.status !== 0) return null;
    const raw = String(probe.stdout || "").trim().split(/\s+/)[0] || "";
    // r_frame_rate is a rational "num/den" (e.g. "24000/1001", "25/1").
    const m = raw.match(/^(\d+)\/(\d+)$/);
    let fps;
    if (m) {
      const num = Number(m[1]); const den = Number(m[2]);
      fps = den > 0 ? num / den : NaN;
    } else {
      fps = Number(raw);
    }
    if (!Number.isFinite(fps) || fps <= 0 || fps > 240) return null; // sane broadcast bounds
    return Math.round(fps * 1000) / 1000; // 3-dp: 23.976, 29.97, 25, 24, 59.94
  } catch {
    return null;
  }
}
// Zero-dependency WebCrypto SigV4 signer (replaces @aws-sdk/@smithy — incident
// 2026-07-07/08). STS session-token aware. See ./s3-signer.js.
const { putS3Object, storageFromEnv } = require("./s3-signer");

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

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `proxy-${project_id}-`));
  const videoPath = path.join(tmpDir, "proxy.mp4");
  const audioPath = path.join(tmpDir, "proxy.flac");

  try {
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
    const ffmpegArgs = [
      "-hide_banner", "-loglevel", "error",
      "-i", source_url,
      // Video proxy: 720p H.264 ~2 Mbps, AAC 128k stereo
      "-map", "0:v:0?", "-map", "0:a:0?",
      "-c:v", "libx264", "-preset", "fast",
      "-b:v", "2M", "-maxrate", "2.5M", "-bufsize", "4M",
      "-vf", "scale=-2:720",
      "-c:a", "aac", "-b:a", "128k", "-ac", "2",
      "-movflags", "+faststart",
      "-f", "mp4", videoPath,
      // Audio proxy: 16 kHz mono FLAC for AssemblyAI / Replicate
      "-map", "0:a:0?", "-vn", "-ac", "1", "-ar", "16000",
      "-c:a", "flac", "-f", "flac", audioPath,
    ];

    // spawnSync with encoding:'utf8' returns stderr/stdout as strings (not
    // Buffers) and populates them EVEN on non-zero exit — unlike execSync,
    // which leaves err.stderr as null in many failure paths. This is the
    // key to enterprise-grade observability: every failure mode is now
    // legible in the response body AND in Railway's structured logs.
    const result = spawnSync("ffmpeg", ffmpegArgs, {
      timeout: 3.5 * 60 * 60 * 1000,
      maxBuffer: 50 * 1024 * 1024,
      encoding: "utf8",
    });

    if (result.status !== 0 || result.signal || result.error) {
      const stderr = (result.stderr || "").toString();
      const stdout = (result.stdout || "").toString();
      const diagnostic = {
        exit_code: result.status,                              // null if killed by signal
        signal: result.signal,                                 // SIGKILL=OOM, SIGTERM=timeout
        stderr_tail: stderr.slice(-2000) || "(empty)",
        stdout_tail: stdout.slice(-500) || "(empty)",
        spawn_error_kind: result.error?.code || null,          // ENOENT (ffmpeg missing), ETIMEDOUT, etc.
        spawn_error_message: result.error?.message || null,
        source_host: sourceHost,
        // Redacted argv — replace the full signed URL with just its host
        // so the audit trail proves what we invoked without leaking the
        // signature. (SOC 2 CC6.x — secrets never appear in logs.)
        ffmpeg_argv: ffmpegArgs.map(a => (typeof a === "string" && a.startsWith("http")) ? `<url:${sourceHost}>` : a),
        duration_ms: Date.now() - t0,
      };
      console.error(`[generate-proxy-sync] ${project_id} ffmpeg failed`, diagnostic);
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
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

    // Probe the SOURCE's true frame rate (best-effort — never blocks the proxy).
    const sourceFrameRate = probeSourceFrameRate(source_url);

    const storage = storageFromEnv({ region, bucket, prefix: credential_secret_prefix });
    const videoBuffer = fs.readFileSync(videoPath);
    const audioBuffer = fs.readFileSync(audioPath);

    await Promise.all([
      putS3Object(storage, proxy_video_key, videoBuffer, { contentType: "video/mp4" }),
      putS3Object(storage, proxy_audio_key, audioBuffer, { contentType: "audio/flac" }),
    ]);

    const durationMs = Date.now() - t0;
    console.log(
      `[generate-proxy-sync] ${project_id} ready ` +
      `(video ${(videoBuffer.length / 1024 / 1024).toFixed(0)}MB, ` +
      `audio ${(audioBuffer.length / 1024 / 1024).toFixed(0)}MB, ` +
      `duration ${durationMs}ms)`
    );

    fs.rmSync(tmpDir, { recursive: true, force: true });

    // ─── Synchronous reply — worker is holding the connection. ───
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      proxy_video_key,
      proxy_audio_key,
      bytes_video: videoBuffer.length,
      bytes_audio: audioBuffer.length,
      duration_ms: durationMs,
      // Machine-measured source frame rate (null if the probe failed). The
      // finalizer writes it to Project.frame_rate with frame_rate_source='ffprobe'.
      source_frame_rate: sourceFrameRate,
      project_id,
    }));
  } catch (err) {
    console.error(`[generate-proxy-sync] ${project_id} fatal:`, err.message, err.stack);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    // 5xx → worker retries once (BullMQ PROXY_GEN_JOB_OPTIONS.attempts=2).
    // Transient: S3 5xx, transient network blip, ENOENT on tmp.
    res.writeHead(500);
    return res.end(JSON.stringify({
      error: "proxy_gen_failed",
      message: String(err.message || err).slice(0, 1000),
      project_id,
    }));
  }
}

// Route descriptor — registered once in index.js's single route table.
const routeProxyGen = { method: "POST", path: "/generate-proxy-sync", handler: handleProxyGenSync };

module.exports = { routeProxyGen };

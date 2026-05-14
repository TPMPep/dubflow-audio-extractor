// proxyGenerator.js — v2 SYNCHRONOUS proxy generation (2026-05-14).
//
// Replaces the legacy fire-and-forget /generate-proxy + webhook callback
// architecture with the same synchronous pattern hlsIngest.js uses. The
// BullMQ worker (bullmq-worker/src/processors/proxy-gen.ts) holds this
// HTTP connection open for up to 3.5hr, heartbeats its job lock every 15s,
// and finalizes the Project entity via proxyGenWorkerStep after we return.
//
// Why the rewrite:
//   The legacy /generate-proxy returned 202 + ran execSync in the background
//   + POSTed a callback back to Base44 when done. Three failure modes:
//     1. execSync starved Node's event loop — /health couldn't answer mid-
//        transcode (Base44's diagnostic probe saw HTTP 30s aborts).
//     2. The 202 response and the ffmpeg kickoff raced on the socket buffer
//        flush — callers timed out before seeing the 202.
//     3. The webhook callback (proxyGenerationCallback) had no retries, no
//        observability, no DLQ — a dropped callback left the Project
//        stuck in 'generating' forever.
//
// New endpoint: POST /generate-proxy-sync
//   • Synchronous reply on the SAME connection (no 202, no callback).
//   • The worker holds the connection (long-timeout fetch + lock heartbeat).
//   • execSync is fine here because Node is single-purpose per request:
//     the worker is the only caller, only one job runs at a time on this
//     dyno (CONCURRENCY_PROXY_GEN=1), and the worker holds the connection
//     so /health responsiveness is no longer the success criterion.
//
// The legacy /generate-proxy route is DELETED. Any caller still using it
// gets a clean 404 — easier to detect + fix than a silent compatibility
// shim. Base44's generateProxy function has been rewritten to call the
// BullMQ worker instead of this endpoint directly.

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

function s3ClientForRegion(region, prefix) {
  const accessKeyId = (prefix && process.env[`${prefix}_ACCESS_KEY_ID`]) || process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = (prefix && process.env[`${prefix}_SECRET_ACCESS_KEY`]) || process.env.AWS_SECRET_ACCESS_KEY;
  return new S3Client({ region, credentials: { accessKeyId, secretAccessKey } });
}

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

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `proxy-${project_id}-`));
  const videoPath = path.join(tmpDir, "proxy.mp4");
  const audioPath = path.join(tmpDir, "proxy.flac");

  try {
    console.log(`[generate-proxy-sync] ${project_id} starting`);

    // Single ffmpeg pass producing both proxies — only decodes source once.
    const cmd =
      `ffmpeg -hide_banner -loglevel error -i "${source_url}" ` +
      // Video proxy: 720p H.264 ~2 Mbps, AAC 128k stereo
      `-map "0:v:0?" -map "0:a:0?" ` +
      `-c:v libx264 -preset fast -b:v 2M -maxrate 2.5M -bufsize 4M ` +
      `-vf "scale=-2:720" ` +
      `-c:a aac -b:a 128k -ac 2 -movflags +faststart ` +
      `-f mp4 "${videoPath}" ` +
      // Audio proxy: 16 kHz mono FLAC for AssemblyAI / Replicate
      `-map "0:a:0?" -vn -ac 1 -ar 16000 -c:a flac -f flac "${audioPath}"`;

    try {
      // execSync is fine in v2: the BullMQ worker holds the connection open
      // and is the only caller. Per-dyno concurrency is 1 so no other
      // request is starved. 3.5hr ceiling matches the worker's fetch timeout.
      execSync(cmd, {
        timeout: 3.5 * 60 * 60 * 1000,
        maxBuffer: 50 * 1024 * 1024,
      });
    } catch (err) {
      const stderrTail = (err.stdout || err.stderr || "").toString().slice(-2000);
      console.error(`[generate-proxy-sync] ${project_id} ffmpeg failed:`, stderrTail);
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      // 4xx → worker's UnrecoverableError → no retry, straight to DLQ.
      // ffmpeg non-zero exit is deterministic; retrying wastes another
      // 5-15min of compute and produces an identical failure row.
      res.writeHead(422, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        error: "proxy_gen_failed",
        message: `ffmpeg exited non-zero: ${stderrTail.slice(-800)}`,
        project_id,
      }));
    }

    const s3 = s3ClientForRegion(region, credential_secret_prefix);
    const videoBuffer = fs.readFileSync(videoPath);
    const audioBuffer = fs.readFileSync(audioPath);

    await Promise.all([
      s3.send(new PutObjectCommand({
        Bucket: bucket, Key: proxy_video_key, Body: videoBuffer, ContentType: "video/mp4",
      })),
      s3.send(new PutObjectCommand({
        Bucket: bucket, Key: proxy_audio_key, Body: audioBuffer, ContentType: "audio/flac",
      })),
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
      project_id,
    }));
  } catch (err) {
    console.error(`[generate-proxy-sync] ${project_id} fatal:`, err.message);
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

function registerProxyGen(server, API_KEY) {
  // Wrap existing request handler — same convention as proxyGenerator (legacy)
  // and hlsIngest.
  const previousListener = server.listeners("request")[0];
  server.removeAllListeners("request");

  server.on("request", async (req, res) => {
    if (req.method === "POST" && req.url === "/generate-proxy-sync") {
      return handleProxyGenSync(req, res, API_KEY);
    }
    if (previousListener) previousListener(req, res);
  });
}

module.exports = { registerProxyGen };

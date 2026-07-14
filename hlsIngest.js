/* eslint-env node */
/* eslint-disable no-undef */
// hlsIngest.js — Bit-faithful HLS-to-MP4 remux for the v2 ingest pipeline.
//
// Pattern matches proxyGenerator.js / mixFinal.js: exports a
// `registerHlsIngest(server, API_KEY)` that mounts a POST /hls-ingest route
// on the existing http server.
//
// IMPORTANT: returns SYNCHRONOUSLY (NOT 202 + callback like proxyGenerator).
// The BullMQ worker (bullmq-worker/src/processors/hls-ingest.ts) holds the
// HTTP connection open with a 15-min timeout + 15s job-lock heartbeat, and
// passes our response back to hlsIngestWorkerStep via carry.railway_response
// so Base44 finalizes the run. Returning 202 here would BREAK the pipeline.
//
// Bit-faithful policy: ffmpeg `-c copy` only — no re-encoding. Compliance
// control hls_remux_pipeline (HLS-INGEST-002) becomes FALSE if you silently
// add `-c:v libx264` etc. Don't.
//
// Codec-conditional bitstream filter: `-bsf:a aac_adtstoasc` is AAC-only and
// will fail outright on AC-3 / E-AC-3 (Dolby) audio. Base44's Phase 2 codec
// gate accepts THREE audio codec families (AAC, AC-3, E-AC-3) and pins the
// resolved codec on the request as `audio_codec`. We branch on it so AAC
// gets the ADTS→ASC framing reformat (required for browser MP4 playback)
// while Dolby streams pass through `-c copy` cleanly. All three remain
// bit-faithful — no transcoding, audio sample bytes unchanged.
//
// User-Agent override: ffmpeg's default UA ("Lavf/x.y.z") is rejected by
// Akamai/CloudFront WAFs as a "bad bot" — manifests fetch fine from Deno
// but ffmpeg gets HTTP 403. We send the same UA Base44 used on its Phase 1
// probe so origin logs see ONE consistent client across the pipeline.
// Auditor-defensible: unique product token, not browser impersonation.
// `-user_agent` must come BEFORE `-i` to apply to the input.

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
// Zero-dependency WebCrypto SigV4 signer (replaces @aws-sdk/@smithy — incident
// 2026-07-07/08). STS session-token aware. See ./s3-signer.js.
const { putS3Object, storageFromEnv } = require("./s3-signer");

const DEFAULT_INGEST_UA = "Mozilla/5.0 (compatible; DubFlowIngest/1.0; +https://dubflow.app/ingest)";

// Build the ffmpeg command. Codec-conditional: AAC gets aac_adtstoasc,
// AC-3 / E-AC-3 / unknown do NOT (the filter is AAC-only and will fail).
function buildFfmpegCmd({ inputUrl, outputPath, audioCodec, userAgent }) {
  const ua = userAgent || DEFAULT_INGEST_UA;
  const codec = String(audioCodec || "").toLowerCase();
  const aacBsf = codec.startsWith("mp4a") ? "-bsf:a aac_adtstoasc " : "";
  return (
    `ffmpeg -y -hide_banner -loglevel warning -nostats ` +
    `-user_agent "${ua}" ` +
    `-i "${inputUrl}" ` +
    `-c copy ${aacBsf}-movflags +faststart ` +
    `"${outputPath}" 2>&1`
  );
}

function registerHlsIngest(server, API_KEY) {
  // Wrap existing request handler — same convention as proxyGenerator.js.
  const previousListener = server.listeners("request")[0];
  server.removeAllListeners("request");

  server.on("request", async (req, res) => {
    if (req.method === "POST" && req.url === "/hls-ingest") {
      return handleHlsIngest(req, res, API_KEY);
    }
    if (previousListener) previousListener(req, res);
  });
}

async function handleHlsIngest(req, res, API_KEY) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString()); }
  catch { res.writeHead(400); return res.end(JSON.stringify({ error: "bad JSON" })); }

  // Same auth pattern as /generate-proxy and /mix-final.
  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.replace("Bearer ", "");
  if (token !== API_KEY && body.api_key !== API_KEY) {
    res.writeHead(401);
    return res.end(JSON.stringify({ error: "Unauthorized" }));
  }

  const required = [
    "project_id", "hls_ingest_run_id", "variant_playlist_url",
    "bucket", "region", "output_key",
  ];
  for (const k of required) {
    if (!body[k]) {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: `${k} required` }));
    }
  }

  const {
    project_id,
    hls_ingest_run_id,
    variant_playlist_url,
    bucket,
    region,
    output_key,
    credential_secret_prefix = "",
    audio_codec,   // Pinned by Base44's Phase 2 codec gate. Drives AAC bsf branch.
    user_agent,    // Optional override; defaults to DEFAULT_INGEST_UA above.
  } = body;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `hls-${hls_ingest_run_id}-`));
  const tmpFile = path.join(tmpDir, "out.mp4");

  const t0 = Date.now();
  try {
    console.log(`[hls-ingest] ${hls_ingest_run_id} start url=${variant_playlist_url} audio=${audio_codec || "unknown"}`);

    const cmd = buildFfmpegCmd({
      inputUrl: variant_playlist_url,
      outputPath: tmpFile,
      audioCodec: audio_codec,
      userAgent: user_agent,
    });
    console.log(`[hls-ingest] ${hls_ingest_run_id} ffmpeg: ${cmd}`);

    try {
      execSync(cmd, { timeout: 14 * 60 * 1000, maxBuffer: 50 * 1024 * 1024 });
    } catch (err) {
      const stderrTail = (err.stdout || err.stderr || "").toString().slice(-2000);
      console.error(`[hls-ingest] ${hls_ingest_run_id} ffmpeg failed:`, stderrTail);
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        error: "hls_ingest_failed",
        message: `ffmpeg exited non-zero: ${stderrTail.slice(-800)}`,
        hls_ingest_run_id,
        project_id,
      }));
    }

    const remuxDurationMs = Date.now() - t0;
    const stat = fs.statSync(tmpFile);
    console.log(`[hls-ingest] ${hls_ingest_run_id} ffmpeg_complete duration_ms=${remuxDurationMs} size=${stat.size}`);

    // ─── Stream upload to S3 — same pattern as proxyGenerator.js ───
    const storage = storageFromEnv({ region, bucket, prefix: credential_secret_prefix });
    const fileBuffer = fs.readFileSync(tmpFile);
    await putS3Object(storage, output_key, fileBuffer, { contentType: "video/mp4" });
    console.log(`[hls-ingest] ${hls_ingest_run_id} s3_uploaded key=${output_key}`);

    fs.rmSync(tmpDir, { recursive: true, force: true });

    // ─── Synchronous reply — worker is holding the connection. ───
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      output_key,
      size_bytes: stat.size,
      remux_duration_ms: remuxDurationMs,
      hls_ingest_run_id,
      project_id,
    }));
  } catch (err) {
    console.error(`[hls-ingest] ${hls_ingest_run_id} fatal:`, err.message);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    res.writeHead(500);
    return res.end(JSON.stringify({
      error: "hls_ingest_failed",
      message: String(err.message || err).slice(0, 1000),
      hls_ingest_run_id,
      project_id,
    }));
  }
}

module.exports = { registerHlsIngest };

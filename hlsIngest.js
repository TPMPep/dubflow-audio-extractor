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
    audio_codec = "",
  } = body;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `hls-${hls_ingest_run_id}-`));
  const tmpFile = path.join(tmpDir, "out.mp4");

  const t0 = Date.now();
  try {
    console.log(`[hls-ingest] ${hls_ingest_run_id} start url=${variant_playlist_url}`);

    // Codec-conditional bitstream filter: aac_adtstoasc is AAC-only and
    // will FAIL on AC-3 / E-AC-3 audio (Apple-style Dolby HLS streams).
    // Base44's Phase 2 codec gate already pinned the audio codec — branch on it.
    // Bit-faithful guarantee preserved: -c copy copies bytes for ALL three
    // codecs; the bsf is just an ADTS->ASC framing reformat for AAC, not a transcode.
    const isAac = String(audio_codec || "").toLowerCase().startsWith("mp4a");
    const audioBsfFlag = isAac ? "-bsf:a aac_adtstoasc " : "";
    const cmd =
      `ffmpeg -y -hide_banner -loglevel warning -nostats ` +
      `-i "${variant_playlist_url}" ` +
      `-c copy ${audioBsfFlag}-movflags +faststart ` +
      `"${tmpFile}" 2>&1`;
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
    const s3 = s3ClientForRegion(region, credential_secret_prefix);
    const fileBuffer = fs.readFileSync(tmpFile);
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: output_key,
      Body: fileBuffer,
      ContentType: "video/mp4",
    }));
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

/* eslint-env node */
/* eslint-disable no-undef */
// =============================================================================
// meExtractUpload.js — POST /extract-and-upload-lalal
// -----------------------------------------------------------------------------
// THE enterprise fix for M&E extraction OOM (2026-08-01). Root cause: the
// Base44 extractME function pulled the ENTIRE extracted audio track into the
// memory-capped Deno function (res.arrayBuffer() → ~500MB for a 44-min lossless
// FLAC), then held that same buffer a second time to POST it to LALAL.AI. On
// long-form + High(FLAC) it blew the function memory ceiling: "Memory limit
// exceeded before EOF." — the function died before it could even finish reading
// the extractor response.
//
// This endpoint moves the whole extract-and-upload off the memory-capped
// function and onto Railway, where the audio already lives on local disk after
// the transcode. It:
//   1. Downloads the source (signed S3 URL) → temp file, extracting audio with
//      ffmpeg to the operator's fidelity codec (192k MP3 standard / lossless
//      FLAC high). Non-blocking spawn — never freezes the event loop.
//   2. STREAMS that temp file from disk → LALAL.AI /upload/ with a bounded
//      ~64KB footprint (fs.createReadStream piped into the fetch body). The
//      audio bytes NEVER live fully in RAM on either Railway or Base44.
//   3. Returns ONLY the tiny LALAL source_id string. extractME then does the
//      /split/ call (a small JSON request) and persists the token — no large
//      payload ever transits the Base44 function again.
//
// Memory is bounded by the ffmpeg temp file on disk + the stream highWaterMark,
// NOT by program length or fidelity. A 3-hour lossless episode uploads with the
// same function-memory footprint as a 30-second clip. SOC 2 CC7.2.
//
// Auth mirrors every other extractor route (Bearer API_KEY or body.api_key).
// A bounded heavy-lane semaphore returns fast-503 under saturation so the
// BullMQ/Base44 caller retries with backoff instead of holding a wedged
// connection open (no Cloudflare 524).
// =============================================================================

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { createSemaphore, putS3ObjectStreaming, storageFromExplicit } = require("./s3-signer");
const { pipeline } = require("stream/promises");

const LALAL_BASE = "https://www.lalal.ai/api/v1";

// Heavy-lane gate — audio extraction of a full program is memory + CPU heavy.
// Cap concurrent M&E extract-uploads (default 3, tunable via EXTRACTOR_MAX_ME).
const ME_SEMAPHORE = createSemaphore(
  Math.max(1, Math.min(6, Number(process.env.EXTRACTOR_MAX_ME) || 3)),
);

// Non-blocking ffmpeg runner (mirrors index.js runFfmpeg). Resolves on exit 0,
// rejects (with captured stderr tail) otherwise, hard-timeout kills a wedged child.
function runFfmpeg(args, { timeoutMs = 30 * 60 * 1000, label = "ffmpeg" } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch (_) { /* gone */ }
      reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stderr.on("data", (d) => { if (stderr.length < 200000) stderr += d.toString(); });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`${label} spawn failed: ${err.message}`));
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) { resolve(); return; }
      const oom = signal === "SIGKILL" || signal === "SIGSEGV";
      reject(new Error(`${label} ${signal ? `killed by ${signal}${oom ? " (likely OOM)" : ""}` : `exited ${code}`}: ${stderr.slice(-800)}`));
    });
  });
}

// Stream a file from disk → LALAL.AI /upload/ with NO in-memory buffering.
// LALAL wants raw bytes in the body + filename in Content-Disposition. Node's
// undici fetch requires duplex:'half' + Content-Length when the body is a
// stream. Peak memory is the stream highWaterMark (~64KB), not the file size.
async function lalalUploadStreaming(lalalKey, filePath, filename) {
  const stat = fs.statSync(filePath);
  const stream = fs.createReadStream(filePath);
  try {
    const res = await fetch(`${LALAL_BASE}/upload/`, {
      method: "POST",
      headers: {
        "X-License-Key": lalalKey,
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename=${filename}`,
        "Content-Length": String(stat.size),
      },
      body: stream,
      duplex: "half",
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`LALAL.AI upload failed: HTTP ${res.status} — ${text.slice(0, 300)}`);
    }
    const data = await res.json();
    if (!data?.id) throw new Error(`LALAL.AI upload returned no source id. Got: ${JSON.stringify(data).slice(0, 300)}`);
    return data.id;
  } finally {
    try { stream.destroy(); } catch (_) { /* already closed */ }
  }
}

async function handleExtractAndUploadLalal(req, res, API_KEY) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString()); }
  catch { res.writeHead(400); return res.end(JSON.stringify({ error: "bad JSON" })); }

  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.replace("Bearer ", "");
  if (token !== API_KEY && body.api_key !== API_KEY) {
    res.writeHead(401);
    return res.end(JSON.stringify({ error: "Unauthorized" }));
  }

  // source_url  — signed S3 GET for the project source media (video or audio).
  // lalal_key   — LALAL.AI license key (forwarded by extractME; the extractor
  //               does NOT store it — it's the caller's secret, used once here).
  // output_format — 'mp3' (standard) or 'flac' (high). Owns the codec.
  // extra_args  — non-codec ffmpeg output flags (e.g. '-vn -ac 2 -b:a 192k').
  // upload_ext  — filename extension LALAL reads to know the source format.
  // filename_base — stable name for the temp/upload file (project-scoped).
  const { source_url, lalal_key, output_format, extra_args = "", upload_ext, filename_base } = body;
  if (!source_url || !lalal_key || !output_format || !upload_ext) {
    res.writeHead(400);
    return res.end(JSON.stringify({ error: "source_url, lalal_key, output_format, upload_ext required" }));
  }

  // Fast-503 under saturation — the caller retries with backoff, no held-open
  // connection, so a Cloudflare 524 is structurally impossible.
  if (!ME_SEMAPHORE.tryAcquire()) {
    res.writeHead(503, { "Content-Type": "application/json", "Retry-After": "30" });
    return res.end(JSON.stringify({ error: "me_lane_busy", retryable: true, message: `M&E extract lane full (${ME_SEMAPHORE.inUse()}/${ME_SEMAPHORE.max}). Retry shortly.` }));
  }

  let tmpDir = null;
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "me-extract-"));
    const audioPath = path.join(tmpDir, `me_source.${output_format}`);

    // 1. Extract the FULL audio to disk in the fidelity codec. -vn drops video;
    //    codec chosen by output_format (mp3→lame, flac→native FLAC). extra_args
    //    carries ONLY non-codec output flags. NO -ss/-t (LALAL handles whole
    //    file). Decode-side hardening for pro-codec masters (ProRes/DNx).
    const codecArgs = output_format === "flac"
      ? ["-c:a", "flac"]
      : ["-c:a", "libmp3lame", "-q:a", "2"];
    const extraArgv = extra_args.trim() ? extra_args.trim().split(/\s+/) : [];
    const ffmpegArgs = [
      "-y",
      "-threads", "1",
      "-fflags", "+genpts",
      "-err_detect", "ignore_err",
      "-i", source_url,
      "-vn",
      ...extraArgv,
      ...codecArgs,
      audioPath,
    ];
    await runFfmpeg(ffmpegArgs, { timeoutMs: 30 * 60 * 1000, label: "M&E audio extract" });

    const stat = fs.statSync(audioPath);
    if (stat.size < 1000) throw new Error(`Extracted audio is degenerate (${stat.size} bytes)`);
    console.log(`[extract-and-upload-lalal] extracted ${(stat.size / 1024 / 1024).toFixed(1)}MB ${output_format}`);

    // 2. STREAM disk → LALAL.AI /upload/ (bounded memory). Returns source_id.
    const filename = `${filename_base || "me_source"}.${upload_ext}`;
    const sourceId = await lalalUploadStreaming(lalal_key, audioPath, filename);
    console.log(`[extract-and-upload-lalal] LALAL source uploaded: ${sourceId}`);

    fs.rmSync(tmpDir, { recursive: true, force: true });
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ success: true, source_id: sourceId, size_bytes: stat.size }));
  } catch (err) {
    console.error("[extract-and-upload-lalal] error:", err.message);
    try { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    res.writeHead(500, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: err.message }));
  } finally {
    ME_SEMAPHORE.release();
  }
}

// =============================================================================
// POST /download-lalal-to-s3 — the HARVEST-side twin of the fix above.
// -----------------------------------------------------------------------------
// THE enterprise fix for M&E HARVEST OOM (2026-08-01). Same root cause as the
// upload side, on the return trip: once LALAL.AI finishes separation, the Base44
// pollMEStatus function pulled the ENTIRE finished M&E bed AND vocals stem into
// the memory-capped Deno function (res.arrayBuffer() → ~500MB EACH for a 44-min
// lossless FLAC) to re-upload them to S3. On long-form + High(FLAC) it died the
// same way: "Memory limit would be exceeded before EOF." — AFTER LALAL had
// already succeeded, so the operator saw "Extraction failed" on a job that
// actually completed.
//
// This route moves the download+upload off the function and onto Railway, which
// streams each LALAL CDN track through DISK straight to S3 with a bounded
// footprint (fetch stream → temp file → putS3ObjectStreaming). The stem bytes
// NEVER live fully in RAM on Base44 OR Railway. pollMEStatus.finalizeME then
// just writes the DB fields from the returned keys — zero bytes buffered.
//
// The caller (pollMEStatus) forwards the project's storage creds (region,
// bucket, access key, secret, optional STS session token) so the writes land in
// the project's own regional bucket via storageFromExplicit — identical trust
// envelope to normalize-voice-sample. SOC 2 CC7.2 / CC8.1.
// =============================================================================

// Stream a LALAL CDN URL → local temp file with NO in-memory buffering, then
// return the temp path + byte size. pipeline() applies proper backpressure so a
// slow S3 write can never let the CDN read outrun memory.
async function streamUrlToFile(url, filePath, label) {
  const dl = await fetch(url);
  if (!dl.ok || !dl.body) throw new Error(`Failed to download ${label}: HTTP ${dl.status}`);
  const out = fs.createWriteStream(filePath);
  await pipeline(dl.body, out);
  const stat = fs.statSync(filePath);
  if (stat.size < 1000) throw new Error(`${label} track is degenerate (${stat.size} bytes)`);
  return stat.size;
}

async function handleDownloadLalalToS3(req, res, API_KEY) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString()); }
  catch { res.writeHead(400); return res.end(JSON.stringify({ error: "bad JSON" })); }

  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.replace("Bearer ", "");
  if (token !== API_KEY && body.api_key !== API_KEY) {
    res.writeHead(401);
    return res.end(JSON.stringify({ error: "Unauthorized" }));
  }

  // tracks       — [{ url, key, label }] to stream CDN → S3 (M&E always; vocals
  //                optional). Each carries its final S3 object key.
  // content_type — the Content-Type to store both stems with (audio/flac|mpeg).
  // aws_*        — the project's storage creds (STS-aware) so writes land in the
  //                project's own regional bucket.
  const {
    tracks, content_type,
    aws_region, target_bucket, aws_access_key_id, aws_secret_access_key, aws_session_token, endpoint,
  } = body;
  if (!Array.isArray(tracks) || tracks.length === 0 || !target_bucket || !aws_access_key_id || !aws_secret_access_key) {
    res.writeHead(400);
    return res.end(JSON.stringify({ error: "tracks[], target_bucket, aws_access_key_id, aws_secret_access_key required" }));
  }

  if (!ME_SEMAPHORE.tryAcquire()) {
    res.writeHead(503, { "Content-Type": "application/json", "Retry-After": "30" });
    return res.end(JSON.stringify({ error: "me_lane_busy", retryable: true, message: `M&E lane full (${ME_SEMAPHORE.inUse()}/${ME_SEMAPHORE.max}). Retry shortly.` }));
  }

  const storage = storageFromExplicit({
    region: aws_region, bucket: target_bucket,
    accessKeyId: aws_access_key_id, secretAccessKey: aws_secret_access_key,
    sessionToken: aws_session_token, endpoint: endpoint || null,
  });

  let tmpDir = null;
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "me-harvest-"));
    const uploaded = [];
    for (const t of tracks) {
      if (!t?.url || !t?.key) throw new Error("each track needs { url, key }");
      const label = t.label || "track";
      const filePath = path.join(tmpDir, `${label}.bin`);
      const size = await streamUrlToFile(t.url, filePath, label);
      await putS3ObjectStreaming(storage, t.key, filePath, { contentType: content_type });
      console.log(`[download-lalal-to-s3] ${label}: ${(size / 1024 / 1024).toFixed(1)}MB → ${t.key}`);
      uploaded.push({ label, key: t.key, size_bytes: size });
      // Free disk between stems so two large FLAC stems never co-reside.
      try { fs.rmSync(filePath, { force: true }); } catch (_) { /* best effort */ }
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ success: true, uploaded }));
  } catch (err) {
    console.error("[download-lalal-to-s3] error:", err.message);
    try { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    res.writeHead(500, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: err.message }));
  } finally {
    ME_SEMAPHORE.release();
  }
}

// Route descriptors — registered once in index.js's single route table.
const routeMeExtractUpload = { method: "POST", path: "/extract-and-upload-lalal", handler: handleExtractAndUploadLalal };
const routeMeDownloadToS3 = { method: "POST", path: "/download-lalal-to-s3", handler: handleDownloadLalalToS3 };

module.exports = { routeMeExtractUpload, routeMeDownloadToS3 };

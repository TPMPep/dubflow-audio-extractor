/* eslint-env node */
/* eslint-disable no-undef */
// textPieces.js — cuts a source video into short pieces for the Inspector
// on-screen text reader, which takes a video only inside the request and only
// up to a fixed size.
//
// One pass re-encodes the picture alone (no audio) at a fixed frame rate with a
// capped bitrate and a keyframe every second, so every piece has a known
// maximum size and can be cut exactly on a second without re-encoding. Each
// piece is then cut by stream copy at the start time the caller planned,
// measured (bytes + SHA-256) and uploaded to the presigned URL the caller
// issued for it. This service holds no storage credentials for this route and
// writes nowhere else. A planned piece that starts after the picture ends is
// reported as empty and not uploaded.
//
// Start + status, like proxy generation: every request is short, so the edge
// never cuts a long encode. Jobs live in memory; a restarted service answers
// 404 for an unknown job and the caller starts again.
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { createSemaphore } = require("./s3-signer");

const FPS = 10;
const MAX_KBPS = 1800;
const LONG_EDGE = 1920;
const ENCODE_TIMEOUT_MS = 3.5 * 60 * 60 * 1000;
const CUT_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_PIECES = 400;
const JOB_RETENTION_MS = 60 * 60 * 1000;
const JOBS = new Map();
const LANE = createSemaphore(Math.max(1, Math.min(4, Number(process.env.EXTRACTOR_MAX_TEXT_PIECES) || 2)));

function run(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", settled = false;
    const timer = setTimeout(() => { if (settled) return; settled = true; try { child.kill("SIGKILL"); } catch (_) { /* gone */ } resolve({ status: null, stdout, stderr, timedOut: true }); }, timeoutMs);
    child.stdout.on("data", (d) => { if (stdout.length < 65536) stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr = (stderr + d.toString()).slice(-8192); });
    child.on("error", (err) => { if (settled) return; settled = true; clearTimeout(timer); reject(err); });
    child.on("close", (code) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ status: code, stdout, stderr, timedOut: false }); });
  });
}

async function upload(putUrl, bytes) {
  let last = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(putUrl, { method: "PUT", headers: { "content-type": "video/mp4" }, body: bytes, signal: AbortSignal.timeout(120000) });
      if (res.ok) return;
      last = `HTTP ${res.status}`;
      if (res.status < 500 && res.status !== 429) break;
    } catch (err) { last = String(err?.message || err); }
    await new Promise((r) => setTimeout(r, attempt * 2000));
  }
  throw new Error(`Could not store a piece (${last}).`);
}

async function work(job, body) {
  let tmpDir = null;
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `text-pieces-${job.id}-`));
    const full = path.join(tmpDir, "picture.mp4");
    const scale = `scale=w='if(gte(iw,ih),2*trunc(min(${LONG_EDGE},iw)/2),-2)':h='if(gte(iw,ih),-2,2*trunc(min(${LONG_EDGE},ih)/2))':flags=lanczos`;
    const encode = await run("ffmpeg", [
      "-hide_banner", "-nostdin", "-y", "-i", body.source_url,
      "-map", "0:v:0", "-an", "-sn", "-dn",
      "-vf", `fps=${FPS},${scale},format=yuv420p`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
      "-maxrate", `${MAX_KBPS}k`, "-bufsize", `${MAX_KBPS * 2}k`,
      "-g", String(FPS), "-keyint_min", String(FPS), "-sc_threshold", "0",
      "-movflags", "+faststart", full,
    ], ENCODE_TIMEOUT_MS);
    if (encode.timedOut) throw new Error("Preparing the picture took longer than the limit.");
    if (encode.status !== 0 || !fs.existsSync(full)) throw new Error(`The picture could not be prepared: ${encode.stderr.slice(-400)}`);

    const probe = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", full], 60000);
    job.encoded_duration_ms = Math.round(parseFloat(probe.stdout) * 1000) || 0;
    job.stage = "cutting";

    for (const piece of body.pieces) {
      const file = path.join(tmpDir, `piece-${piece.index}.mp4`);
      const startS = (piece.start_ms / 1000).toFixed(3);
      const cut = piece.start_ms >= job.encoded_duration_ms ? null : await run("ffmpeg", [
        "-hide_banner", "-nostdin", "-y", "-ss", startS, "-i", full, "-t", (body.piece_ms / 1000).toFixed(3),
        "-c", "copy", "-avoid_negative_ts", "make_zero", "-movflags", "+faststart", file,
      ], CUT_TIMEOUT_MS);
      if (cut && (cut.timedOut || cut.status !== 0)) throw new Error(`Piece ${piece.index + 1} could not be cut: ${cut.timedOut ? "timed out" : cut.stderr.slice(-300)}`);
      const size = cut && fs.existsSync(file) ? fs.statSync(file).size : 0;
      if (size < 2048) { job.pieces.push({ index: piece.index, empty: true }); job.pieces_done += 1; continue; }
      if (size > body.max_piece_bytes) throw new Error(`Piece ${piece.index + 1} is ${size} bytes, over the ${body.max_piece_bytes} byte limit.`);
      const bytes = fs.readFileSync(file);
      await upload(piece.put_url, bytes);
      job.pieces.push({ index: piece.index, empty: false, bytes: size, sha256: crypto.createHash("sha256").update(bytes).digest("hex") });
      job.pieces_done += 1;
      fs.unlinkSync(file);
    }
    job.state = "done";
  } catch (err) {
    job.state = "failed";
    job.error = String(err?.message || err).slice(0, 600);
    console.error(`[text-pieces] ${job.project_id} run ${job.run_id} failed: ${job.error}`);
  } finally {
    job.finished_at = Date.now();
    if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* best effort */ } }
    LANE.release();
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}
const authorized = (req, body, API_KEY) => (req.headers["authorization"] || "").replace("Bearer ", "") === API_KEY || body?.api_key === API_KEY;
const reply = (res, status, payload, headers = {}) => { res.writeHead(status, { "Content-Type": "application/json", ...headers }); return res.end(JSON.stringify(payload)); };
const https = (u) => { try { return new URL(u).protocol === "https:"; } catch { return false; } };

async function handleStart(req, res, API_KEY) {
  let body;
  try { body = await readBody(req); } catch { return reply(res, 400, { error: "bad JSON" }); }
  if (!authorized(req, body, API_KEY)) return reply(res, 401, { error: "Unauthorized" });
  const pieces = Array.isArray(body.pieces) ? body.pieces : [];
  const valid = body.project_id && body.run_id && https(body.source_url) && Number(body.piece_ms) > 0 && Number(body.max_piece_bytes) > 0
    && pieces.length > 0 && pieces.length <= MAX_PIECES
    && pieces.every((p) => Number.isInteger(p.index) && Number(p.start_ms) >= 0 && Number(p.start_ms) % 1000 === 0 && https(p.put_url));
  if (!valid) return reply(res, 400, { error: "project_id, run_id, source_url, piece_ms, max_piece_bytes and pieces (index, start_ms on a whole second, put_url) are required" });
  for (const [id, j] of JOBS) if (j.finished_at && Date.now() - j.finished_at > JOB_RETENTION_MS) JOBS.delete(id);
  if (!LANE.tryAcquire()) return reply(res, 503, { error: "text_pieces_lane_busy", retryable: true }, { "Retry-After": "30" });
  const job = { id: crypto.randomUUID(), project_id: String(body.project_id), run_id: String(body.run_id), state: "running", stage: "encoding", pieces_total: pieces.length, pieces_done: 0, pieces: [], encoded_duration_ms: null, error: null, started_at: Date.now(), finished_at: null };
  JOBS.set(job.id, job);
  work(job, body);
  return reply(res, 202, { job_id: job.id, fps: FPS, max_kbps: MAX_KBPS });
}

async function handleStatus(req, res, API_KEY) {
  let body;
  try { body = await readBody(req); } catch { return reply(res, 400, { error: "bad JSON" }); }
  if (!authorized(req, body, API_KEY)) return reply(res, 401, { error: "Unauthorized" });
  const job = JOBS.get(String(body.job_id || ""));
  if (!job) return reply(res, 404, { error: "job_not_found" });
  return reply(res, 200, { state: job.state, stage: job.stage, pieces_total: job.pieces_total, pieces_done: job.pieces_done, pieces: job.state === "done" ? job.pieces : [], encoded_duration_ms: job.encoded_duration_ms, error: job.error, elapsed_ms: Date.now() - job.started_at });
}

const routeTextPiecesStart = { method: "POST", path: "/text-pieces-start", handler: handleStart };
const routeTextPiecesStatus = { method: "POST", path: "/text-pieces-status", handler: handleStatus };

module.exports = { routeTextPiecesStart, routeTextPiecesStatus };

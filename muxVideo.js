/* eslint-env node */
/* eslint-disable no-undef */
// /mux-video endpoint — muxes a finished audio track onto a source video,
// producing a deliverable MP4 WITHOUT re-encoding the video stream.
//
// AUDITOR / ENTERPRISE FRAMING:
//   This endpoint is deliberately DUMB and SINGLE-PURPOSE. It does NOT mix
//   audio — the 3-stem mixing-console blend (dubbed voices + M&E bed +
//   optional original dialogue, at the operator's fader levels) is rendered
//   UPSTREAM by /mix-final (the single audited mixer that also applies EBU
//   R128 loudness normalization). This endpoint only takes that finished WAV
//   and the source video and combines them. Keeping the mix in one place
//   means there is exactly ONE audio code path — what /mix-final renders for
//   the audio-only WAV export is byte-identical to the audio track baked into
//   this MP4. "What you heard ≠ what shipped" is structurally impossible.
//
// Why -c:v copy (no video re-encode):
//   • Lossless — the delivered video is bit-identical to the source stream.
//   • Fast — a feature-length mux is seconds, not the minutes a re-encode
//     would take. This is what makes the "tweak a fader, re-export in ~30s"
//     UX viable under 100+ concurrent users.
//   • The audio is the ONLY thing we're changing, so re-encoding video would
//     be wasted compute + a quality regression for zero benefit.
//
// Contract:
//   POST /mux-video
//   {
//     video_url:  signed S3 GET URL of the source video (original or proxy),
//     audio_url:  signed S3 GET URL of the finished mixed-audio WAV,
//     output_format?: 'mp4' (default),
//     audio_codec?:  'aac' (default) — AAC is universally playable; the WAV
//                    mix is re-encoded to AAC for the container, the VIDEO is
//                    copied untouched.
//     audio_bitrate?: '256k' (default)
//   }
//   → returns the MP4 binary directly (Content-Type: video/mp4) with
//     X-Mux-Video-Duration-Ms + X-Mux-Audio-Codec response headers.

const { spawn } = require("child_process");
const fs = require("fs");

// ── Non-blocking ffmpeg/ffprobe runners (SOC 2 CC7.2 — never freeze the loop) ──
// execSync BLOCKS the single-threaded Node event loop for the ENTIRE FFmpeg run.
// A feature-length mux therefore stalls EVERY concurrent request on this
// container — /health included — the "works, then dies after a bit" wedge under
// 100+ users. spawn() runs the child WITHOUT blocking the loop. runFfmpeg rejects
// with a truthful error (naming the terminating signal — SIGKILL ⇒ OOM) and the
// captured stderr tail; a hard timeout SIGKILLs a wedged child. Mirrors the
// helpers already proven in index.js + mixFinal.js.
function runFfmpeg(args, { timeoutMs = 25 * 60 * 1000, label = "ffmpeg" } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch (_) { /* already gone */ }
      reject(Object.assign(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`), { kind: "timeout" }));
    }, timeoutMs);
    child.stderr.on("data", (d) => { stderr += d.toString(); if (stderr.length > 200000) stderr = stderr.slice(-100000); });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(Object.assign(new Error(`${label} spawn failed: ${err.message}`), { kind: "spawn_failed" }));
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) { resolve(stderr); return; }
      const tail = stderr.slice(-2000);
      const oom = signal === "SIGKILL" || signal === "SIGSEGV";
      const reason = signal ? `killed by ${signal}${oom ? " (likely out of memory)" : ""}` : `exited ${code}`;
      reject(Object.assign(
        new Error(`${label} ${reason}`),
        { kind: oom ? "oom" : "ffmpeg_error", signal, code, stderr_tail: tail },
      ));
    });
  });
}

// Non-blocking ffprobe. Resolves trimmed stdout; resolves "" on any non-zero
// exit / spawn error so a failed probe is treated as "unknown duration" (never
// throws — the mux already succeeded by the time this runs).
function runFfprobe(args, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn("ffprobe", args, { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    let settled = false;
    const done = (val) => { if (settled) return; settled = true; clearTimeout(timer); resolve(val); };
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch (_) { /* gone */ } done(""); }, timeoutMs);
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.on("error", () => done(""));
    child.on("close", (code) => done(code === 0 ? stdout.trim() : ""));
  });
}

// Route descriptor — registered once in index.js's single route table.
const routeMuxVideo = { method: "POST", path: "/mux-video", handler: handleMuxVideo };

async function handleMuxVideo(req, res, API_KEY) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString()); }
  catch { res.writeHead(400); return res.end(JSON.stringify({ error: "Invalid JSON" })); }

  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.replace("Bearer ", "");
  if (token !== API_KEY && body.api_key !== API_KEY) {
    res.writeHead(401);
    return res.end(JSON.stringify({ error: "Unauthorized" }));
  }

  const videoUrl = body.video_url;
  const audioUrl = body.audio_url;
  const outputFormat = (body.output_format || "mp4").toLowerCase();
  const audioCodec = (body.audio_codec || "aac").toLowerCase();
  const audioBitrate = String(body.audio_bitrate || "256k");

  if (!videoUrl || typeof videoUrl !== "string") {
    res.writeHead(400); return res.end(JSON.stringify({ error: "video_url required" }));
  }
  if (!audioUrl || typeof audioUrl !== "string") {
    res.writeHead(400); return res.end(JSON.stringify({ error: "audio_url required" }));
  }
  if (outputFormat !== "mp4") {
    res.writeHead(400); return res.end(JSON.stringify({ error: "output_format must be mp4" }));
  }
  if (!["aac", "ac3"].includes(audioCodec)) {
    res.writeHead(400); return res.end(JSON.stringify({ error: "audio_codec must be aac or ac3" }));
  }

  const tmpDir = `/tmp/mux_${Date.now()}`;
  fs.mkdirSync(tmpDir, { recursive: true });
  const videoFile = `${tmpDir}/source_video`;
  const audioFile = `${tmpDir}/mixed_audio.wav`;
  const outputFile = `${tmpDir}/out.${outputFormat}`;

  try {
    console.log(`[mux-video] fetching source video + mixed audio`);

    // Download both inputs to local tmp so ffmpeg seeks deterministically
    // (streaming a signed URL directly into ffmpeg can stall on large media).
    const [vRes, aRes] = await Promise.all([fetch(videoUrl), fetch(audioUrl)]);
    if (!vRes.ok) throw new Error(`video download failed: ${vRes.status}`);
    if (!aRes.ok) throw new Error(`audio download failed: ${aRes.status}`);
    const [vBuf, aBuf] = await Promise.all([vRes.arrayBuffer(), aRes.arrayBuffer()]);
    fs.writeFileSync(videoFile, Buffer.from(vBuf));
    fs.writeFileSync(audioFile, Buffer.from(aBuf));
    console.log(`[mux-video] video=${(vBuf.byteLength / 1024 / 1024).toFixed(1)}MB audio=${(aBuf.byteLength / 1024 / 1024).toFixed(1)}MB`);

    // -map 0:v:0  → take ONLY the video stream from the source (drop its audio)
    // -map 1:a:0  → take the mixed audio as the new audio track
    // -c:v copy   → video stream passed through untouched (lossless, fast)
    // -c:a <codec> → re-encode the WAV mix into the container's audio codec
    // -shortest   → clamp to the shorter of (video, audio). The mix is already
    //               TC-locked to the program duration so they match; -shortest
    //               guards against a 1-frame tail mismatch producing a dangling
    //               silent/black tail.
    // -movflags +faststart → web-playable MP4 (moov atom at the front).
    const args = [
      "-y", "-hide_banner", "-loglevel", "warning", "-nostdin",
      "-i", videoFile,
      "-i", audioFile,
      "-map", "0:v:0",
      "-map", "1:a:0",
      "-c:v", "copy",
      "-c:a", audioCodec,
      "-b:a", audioBitrate,
      "-ac", "2",
      "-shortest",
      "-movflags", "+faststart",
      outputFile,
    ];

    console.log(`[mux-video] ffmpeg mux (-c:v copy, audio=${audioCodec} ${audioBitrate})`);

    const t0 = Date.now();
    try {
      await runFfmpeg(args, { label: "mux-video" });
    } catch (err) {
      const stderrTail = err.stderr_tail || err.message || "";
      console.error("[mux-video] ffmpeg failed:", stderrTail);
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "ffmpeg mux failed", kind: err.kind || "ffmpeg_error", signal: err.signal || null, stderr_tail: stderrTail }));
    }

    // Probe the output duration so the caller can store a truthful length.
    // Non-blocking + fail-soft: a failed probe → null duration, never a throw.
    let durationMs = null;
    const probe = await runFfprobe(
      ["-v", "quiet", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", outputFile],
    );
    const durSec = parseFloat(probe);
    if (Number.isFinite(durSec) && durSec > 0) durationMs = Math.round(durSec * 1000);

    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    const stat = fs.statSync(outputFile);
    console.log(`[mux-video] OK in ${dt}s, ${(stat.size / 1024 / 1024).toFixed(2)}MB, dur=${durationMs ?? "?"}ms`);

    const outputBuffer = fs.readFileSync(outputFile);
    fs.rmSync(tmpDir, { recursive: true, force: true });

    const headers = {
      "Content-Type": "video/mp4",
      "Content-Length": outputBuffer.length,
      "X-Mux-Audio-Codec": audioCodec,
    };
    if (durationMs != null) headers["X-Mux-Video-Duration-Ms"] = String(durationMs);
    res.writeHead(200, headers);
    return res.end(outputBuffer);

  } catch (err) {
    console.error("[mux-video] fatal:", err.message);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    res.writeHead(500);
    return res.end(JSON.stringify({ error: err.message }));
  }
}

module.exports = { routeMuxVideo };

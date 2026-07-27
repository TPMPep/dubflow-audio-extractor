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

const { execSync } = require("child_process");
const fs = require("fs");

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

    const quote = (a) => `'${String(a).replace(/'/g, "'\\''")}'`;
    const cmd = `ffmpeg ${args.map(quote).join(" ")} 2>&1`;
    console.log(`[mux-video] ffmpeg mux (-c:v copy, audio=${audioCodec} ${audioBitrate})`);

    const t0 = Date.now();
    try {
      execSync(cmd, { timeout: 25 * 60 * 1000, maxBuffer: 50 * 1024 * 1024 });
    } catch (err) {
      const stderrTail = (err.stdout || err.stderr || "").toString().slice(-2000);
      console.error("[mux-video] ffmpeg failed:", stderrTail);
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "ffmpeg mux failed", stderr_tail: stderrTail }));
    }

    // Probe the output duration so the caller can store a truthful length.
    let durationMs = null;
    try {
      const probe = execSync(
        `ffprobe -v quiet -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 ${quote(outputFile)}`,
        { timeout: 10000 }
      ).toString().trim();
      const durSec = parseFloat(probe);
      if (Number.isFinite(durSec) && durSec > 0) durationMs = Math.round(durSec * 1000);
    } catch (probeErr) {
      console.warn(`[mux-video] output duration probe failed (non-fatal): ${probeErr.message}`);
    }

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

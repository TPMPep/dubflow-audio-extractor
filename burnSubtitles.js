/* eslint-env node */
/* eslint-disable no-undef */
// /burn-subtitles endpoint — burns (hardsubs) a Timed-Text caption track onto a
// source video, producing a deliverable MP4. This is the ONE endpoint in the
// audio-extractor where the VIDEO stream IS re-encoded — hardsub is impossible
// with -c:v copy (the pixels themselves change).
//
// AUDITOR / ENTERPRISE FRAMING (FCC 47 CFR §79.1 / SOC 2 CC8.1 / TPN MS-4.x):
//   • The caption styling is NOT decided here. The caller (Base44) compiles the
//     project's pinned ClosedCaptionSpec into a full ASS (Advanced SubStation
//     Alpha) document via lib/cc-ass-styler and hands us the finished ASS bytes
//     (as a signed S3 URL). This endpoint is a DUMB renderer: fetch video +
//     fetch ASS → ffmpeg subtitles filter → MP4. Reproducible: the same
//     (video, ASS) always yields the same burn; the ASS style hash is pinned on
//     ExportJob.cc_ass_style_hash so an auditor can prove which styling shipped.
//   • ASS (not SRT) because FFmpeg's `subtitles` filter honors full per-style
//     presentation (font, size, box colour/opacity, alignment, safe-zone
//     margins) ONLY via ASS. That is the whole point of a SPEC-faithful burn.
//
// Why the video IS re-encoded (unlike /mux-video):
//   • Hardsub paints the captions into the frames — the pixel data changes, so
//     -c:v copy is physically impossible. We re-encode H.264 at a high-quality
//     CRF and copy the source AUDIO untouched (-c:a copy) since we don't touch it.
//   • This is a MINUTES-long operation on a feature-length program (that is why
//     it is worker-orchestrated with a heartbeat-extended lock, never in-band).
//
// Contract:
//   POST /burn-subtitles
//   {
//     video_url:    signed S3 GET URL of the source video (original or proxy),
//     subtitles_url: signed S3 GET URL of the compiled .ass document,
//     output_format?: 'mp4' (default),
//     crf?: 18 (default — visually lossless; 0=lossless huge, 51=worst),
//     preset?: 'medium' (default x264 speed/size trade-off)
//   }
//   → returns the MP4 binary (Content-Type: video/mp4) with
//     X-Burn-Video-Duration-Ms response header.

const { execSync } = require("child_process");
const fs = require("fs");

function registerBurnSubtitles(server, API_KEY) {
  const originalListeners = server.listeners("request").slice();
  server.removeAllListeners("request");

  server.on("request", async (req, res) => {
    if (req.method === "POST" && req.url === "/burn-subtitles") {
      return handleBurnSubtitles(req, res, API_KEY);
    }
    for (const listener of originalListeners) listener(req, res);
  });
}

async function handleBurnSubtitles(req, res, API_KEY) {
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
  const subtitlesUrl = body.subtitles_url;
  const outputFormat = (body.output_format || "mp4").toLowerCase();
  // CRF 18 = visually lossless for delivery; clamp to a sane range.
  let crf = Number.isFinite(Number(body.crf)) ? Math.round(Number(body.crf)) : 18;
  crf = Math.max(0, Math.min(51, crf));
  const preset = String(body.preset || "medium");
  const ALLOWED_PRESETS = new Set(["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"]);
  const encPreset = ALLOWED_PRESETS.has(preset) ? preset : "medium";

  if (!videoUrl || typeof videoUrl !== "string") {
    res.writeHead(400); return res.end(JSON.stringify({ error: "video_url required" }));
  }
  if (!subtitlesUrl || typeof subtitlesUrl !== "string") {
    res.writeHead(400); return res.end(JSON.stringify({ error: "subtitles_url required" }));
  }
  if (outputFormat !== "mp4") {
    res.writeHead(400); return res.end(JSON.stringify({ error: "output_format must be mp4" }));
  }

  const tmpDir = `/tmp/burn_${Date.now()}`;
  fs.mkdirSync(tmpDir, { recursive: true });
  const videoFile = `${tmpDir}/source_video`;
  // The subtitles filter reads the file by path; .ass extension lets libass
  // auto-detect the format.
  const assFile = `${tmpDir}/captions.ass`;
  const outputFile = `${tmpDir}/out.${outputFormat}`;

  try {
    console.log(`[burn-subtitles] fetching source video + compiled ASS`);

    // Download both inputs to local tmp so ffmpeg seeks deterministically.
    const [vRes, aRes] = await Promise.all([fetch(videoUrl), fetch(subtitlesUrl)]);
    if (!vRes.ok) throw new Error(`video download failed: ${vRes.status}`);
    if (!aRes.ok) throw new Error(`subtitles download failed: ${aRes.status}`);
    const [vBuf, aBuf] = await Promise.all([vRes.arrayBuffer(), aRes.arrayBuffer()]);
    fs.writeFileSync(videoFile, Buffer.from(vBuf));
    fs.writeFileSync(assFile, Buffer.from(aBuf));
    console.log(`[burn-subtitles] video=${(vBuf.byteLength / 1024 / 1024).toFixed(1)}MB ass=${(aBuf.byteLength / 1024).toFixed(1)}KB`);

    // The subtitles filter needs the ASS path escaped for the filtergraph
    // (colons + backslashes are filtergraph metacharacters). We wrote the ASS
    // to a fixed, metacharacter-free tmp path, but escape defensively anyway.
    const assFilterPath = assFile.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");

    // -vf subtitles=…  → hardsub the ASS (libass honors the full V4+ style)
    // -c:v libx264 -crf -preset → re-encode video (REQUIRED for hardsub)
    // -pix_fmt yuv420p → universally playable colour space
    // -c:a copy → source AUDIO passed through untouched (we don't change it)
    // -movflags +faststart → web-playable MP4 (moov atom at the front)
    const args = [
      "-y", "-hide_banner", "-loglevel", "warning", "-nostdin",
      "-i", videoFile,
      "-vf", `subtitles='${assFilterPath}'`,
      "-c:v", "libx264",
      "-crf", String(crf),
      "-preset", encPreset,
      "-pix_fmt", "yuv420p",
      "-c:a", "copy",
      "-movflags", "+faststart",
      outputFile,
    ];

    const quote = (a) => `'${String(a).replace(/'/g, "'\\''")}'`;
    const cmd = `ffmpeg ${args.map(quote).join(" ")} 2>&1`;
    console.log(`[burn-subtitles] ffmpeg hardsub (libx264 crf=${crf} preset=${encPreset}, audio copy)`);

    const t0 = Date.now();
    try {
      // Hardsub re-encodes the whole video — allow the full ffmpeg ceiling.
      execSync(cmd, { timeout: 55 * 60 * 1000, maxBuffer: 50 * 1024 * 1024 });
    } catch (err) {
      const stderrTail = (err.stdout || err.stderr || "").toString().slice(-2000);
      console.error("[burn-subtitles] ffmpeg failed:", stderrTail);
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "ffmpeg burn failed", stderr_tail: stderrTail }));
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
      console.warn(`[burn-subtitles] output duration probe failed (non-fatal): ${probeErr.message}`);
    }

    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    const stat = fs.statSync(outputFile);
    console.log(`[burn-subtitles] OK in ${dt}s, ${(stat.size / 1024 / 1024).toFixed(2)}MB, dur=${durationMs ?? "?"}ms`);

    const outputBuffer = fs.readFileSync(outputFile);
    fs.rmSync(tmpDir, { recursive: true, force: true });

    const headers = {
      "Content-Type": "video/mp4",
      "Content-Length": outputBuffer.length,
    };
    if (durationMs != null) headers["X-Burn-Video-Duration-Ms"] = String(durationMs);
    res.writeHead(200, headers);
    return res.end(outputBuffer);

  } catch (err) {
    console.error("[burn-subtitles] fatal:", err.message);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    res.writeHead(500);
    return res.end(JSON.stringify({ error: err.message }));
  }
}

module.exports = { registerBurnSubtitles };

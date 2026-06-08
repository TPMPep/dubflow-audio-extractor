/* eslint-env node */
/* eslint-disable no-undef */
// /mix-final endpoint — enterprise multi-clip audio mixer.
// Single FFmpeg pass with filter_complex graph. Eliminates boundary pops
// and clipping by design. Called by Base44 buildFinalMix function.
//
// Supports optional EBU R128 / ITU-R BS.1770 loudness normalization on the
// final program (post-mix, including M&E bed if present). Industry standard
// for broadcast and streaming deliverables (Netflix, Apple TV+, EBU, BBC).

const { execSync } = require("child_process");
const fs = require("fs");

function registerMixFinal(server, API_KEY) {
  const originalListeners = server.listeners("request").slice();
  server.removeAllListeners("request");

  server.on("request", async (req, res) => {
    if (req.method === "POST" && req.url === "/mix-final") {
      return handleMixFinal(req, res, API_KEY);
    }
    // Fall through to the original handler
    for (const listener of originalListeners) listener(req, res);
  });
}

async function handleMixFinal(req, res, API_KEY) {
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

  const MAX_CLIPS = 5000;
  const MAX_DURATION_MS = 4 * 3600 * 1000;
  const clips = Array.isArray(body.clips) ? body.clips : [];
  const meTrack = body.me_track || null;
  const durationMs = Number(body.duration_ms);
  const outputFormat = (body.output_format || "wav").toLowerCase();
  const sampleRate = Number(body.sample_rate || 48000);
  // Asymmetric micro-fades on every clip — must match the /time-stretch
  // fitting pass so the program mix never reintroduces a boundary pop the
  // fitted clips already suppressed. Defaults are the production contract:
  // 8ms in, 12ms out (tail bumped because near-peak clip-end signal is the
  // dominant audible pop). `fade_ms` is kept as a back-compat alias for the
  // fade-IN value only; legacy callers passing a single fade_ms get 8ms-style
  // symmetric behavior unless they opt into the asymmetric pair.
  const _legacyFade = body.fade_ms != null ? Number(body.fade_ms) : null;
  const fadeInMs = Math.max(0, Math.min(50, Number(body.fade_in_ms ?? _legacyFade ?? 8)));
  const fadeOutMs = Math.max(0, Math.min(50, Number(body.fade_out_ms ?? _legacyFade ?? 12)));

  // EBU R128 loudness normalization target (LUFS).
  // Accepted values:
  //   -16 → streaming (Netflix Sound Mix Spec, Apple TV+, Spotify, YouTube)
  //   -23 → broadcast (EBU R128, ATSC A/85, BBC)
  //   null / undefined → no normalization (raw mix)
  // True-peak ceiling is always -1 dBTP. Loudness range 11 LU
  // (industry-standard envelope — preserves performance dynamics while
  // controlling overall program loudness).
  const loudnessTargetLufs = body.loudness_target_lufs != null
    ? Number(body.loudness_target_lufs)
    : null;
  if (loudnessTargetLufs != null && ![-16, -23].includes(loudnessTargetLufs)) {
    res.writeHead(400);
    return res.end(JSON.stringify({ error: "loudness_target_lufs must be -16 or -23" }));
  }

  if (clips.length === 0) { res.writeHead(400); return res.end(JSON.stringify({ error: "clips array required and non-empty" })); }
  if (clips.length > MAX_CLIPS) { res.writeHead(400); return res.end(JSON.stringify({ error: `too many clips (max ${MAX_CLIPS})` })); }
  if (!Number.isFinite(durationMs) || durationMs <= 0) { res.writeHead(400); return res.end(JSON.stringify({ error: "duration_ms required and must be > 0" })); }
  if (durationMs > MAX_DURATION_MS) { res.writeHead(400); return res.end(JSON.stringify({ error: `duration_ms exceeds max (${MAX_DURATION_MS})` })); }
  if (!["wav", "mp3", "aac"].includes(outputFormat)) { res.writeHead(400); return res.end(JSON.stringify({ error: "output_format must be wav, mp3, or aac" })); }
  if (![44100, 48000].includes(sampleRate)) { res.writeHead(400); return res.end(JSON.stringify({ error: "sample_rate must be 44100 or 48000" })); }

  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    if (!c || typeof c !== "object" || typeof c.url !== "string" || !c.url) {
      res.writeHead(400); return res.end(JSON.stringify({ error: `clips[${i}].url required` }));
    }
    if (!Number.isFinite(Number(c.start_ms)) || Number(c.start_ms) < 0) {
      res.writeHead(400); return res.end(JSON.stringify({ error: `clips[${i}].start_ms must be >= 0` }));
    }
  }
  if (meTrack && (typeof meTrack !== "object" || typeof meTrack.url !== "string")) {
    res.writeHead(400); return res.end(JSON.stringify({ error: "me_track.url required when me_track is set" }));
  }

  const tmpDir = `/tmp/mix_${Date.now()}`;
  fs.mkdirSync(tmpDir, { recursive: true });
  const outputFile = `${tmpDir}/out.${outputFormat}`;
  const durationSec = durationMs / 1000;
  const fadeInSec = fadeInMs / 1000;
  const fadeOutSec = fadeOutMs / 1000;
  const fadeMs = Math.max(fadeInMs, fadeOutMs); // log/telemetry summary only

  try {
    console.log(`[mix-final] ${clips.length} clips, me=${!!meTrack}, dur=${durationMs}ms, fmt=${outputFormat}, sr=${sampleRate}, loudnorm=${loudnessTargetLufs ?? "off"}`);

    const args = ["-y", "-hide_banner", "-loglevel", "warning", "-nostdin"];
    args.push("-f", "lavfi", "-t", String(durationSec),
      "-i", `anullsrc=channel_layout=stereo:sample_rate=${sampleRate}`);
    for (const c of clips) args.push("-i", c.url);
    if (meTrack) args.push("-i", meTrack.url);

    const filterParts = [];
    filterParts.push(`[0:a]aformat=sample_fmts=fltp:sample_rates=${sampleRate}:channel_layouts=stereo[base]`);

    const mixLabels = ["[base]"];
    for (let i = 0; i < clips.length; i++) {
      const c = clips[i];
      const idx = i + 1;
      const delay = Math.max(0, Math.round(Number(c.start_ms)));
      const gainDb = Number(c.gain_db) || 0;

      // Asymmetric micro-fades on every clip. The fade-OUT uses the areverse
      // trick (a fade-IN on the reversed signal == a fade-OUT on the forward
      // signal), which needs no knowledge of the clip's intrinsic duration.
      // fade-IN is applied head-on. apad extends each clip with digital silence
      // so amix=duration=first clamps the program to the base track length.
      const fadeInPart = fadeInSec > 0 ? `afade=t=in:st=0:d=${fadeInSec}:curve=tri,` : "";
      const fadeOutPart = fadeOutSec > 0 ? `areverse,afade=t=in:st=0:d=${fadeOutSec}:curve=tri,areverse,` : "";
      const chain =
        `[${idx}:a]` +
        `aformat=sample_fmts=fltp:sample_rates=${sampleRate}:channel_layouts=stereo,` +
        fadeInPart +
        fadeOutPart +
        (gainDb !== 0 ? `volume=${gainDb}dB,` : "") +
        `adelay=${delay}|${delay},` +
        `apad` +
        `[c${i}]`;
      filterParts.push(chain);
      mixLabels.push(`[c${i}]`);
    }

    if (meTrack) {
      const meIdx = clips.length + 1;
      const meGain = Number(meTrack.gain_db ?? -6);
      filterParts.push(
        `[${meIdx}:a]aformat=sample_fmts=fltp:sample_rates=${sampleRate}:channel_layouts=stereo,` +
        `volume=${meGain}dB[me]`
      );
      mixLabels.push("[me]");
    }

    filterParts.push(
      `${mixLabels.join("")}` +
      `amix=inputs=${mixLabels.length}:duration=first:normalize=0:dropout_transition=0` +
      `[mix]`
    );

    // Final output stage. When loudness normalization is requested, append the
    // single-pass loudnorm filter (FFmpeg's implementation of ITU-R BS.1770-4).
    // print_format=summary logs measured input/output LUFS to Railway logs —
    // auditor evidence that the system can prove what loudness it produced.
    const loudnormSuffix = loudnessTargetLufs != null
      ? `,loudnorm=I=${loudnessTargetLufs}:TP=-1:LRA=11:print_format=summary`
      : "";
    filterParts.push(`[mix]atrim=0:${durationSec},asetpts=PTS-STARTPTS${loudnormSuffix}[out]`);

    const filterComplex = filterParts.join(";");
    const filterFile = `${tmpDir}/filter.txt`;
    fs.writeFileSync(filterFile, filterComplex);

    args.push("-filter_complex_script", filterFile, "-map", "[out]");

    if (outputFormat === "wav") {
      args.push("-c:a", "pcm_s24le", "-ar", String(sampleRate), "-ac", "2");
    } else if (outputFormat === "mp3") {
      args.push("-c:a", "libmp3lame", "-b:a", "320k", "-ar", String(sampleRate), "-ac", "2");
    } else if (outputFormat === "aac") {
      args.push("-c:a", "aac", "-b:a", "256k", "-ar", String(sampleRate), "-ac", "2");
    }
    args.push(outputFile);

    const quote = (a) => `'${String(a).replace(/'/g, "'\\''")}'`;
    const cmd = `ffmpeg ${args.map(quote).join(" ")} 2>&1`;
    console.log(`[mix-final] ffmpeg: ${args.length} args, filter graph ${filterComplex.length} bytes`);

    const t0 = Date.now();
    let ffmpegOutput = "";
    try {
      ffmpegOutput = execSync(cmd, { timeout: 25 * 60 * 1000, maxBuffer: 50 * 1024 * 1024 }).toString();
    } catch (err) {
      const stderrTail = (err.stdout || err.stderr || "").toString().slice(-2000);
      console.error("[mix-final] ffmpeg failed:", stderrTail);
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "ffmpeg failed", stderr_tail: stderrTail }));
    }

    // If loudnorm ran, log the measured summary block so auditors can read it
    // back from Railway logs. The summary block contains "Input Integrated",
    // "Output Integrated", "Output True Peak", etc.
    if (loudnessTargetLufs != null && ffmpegOutput) {
      const summaryIdx = ffmpegOutput.indexOf("Input Integrated");
      if (summaryIdx >= 0) {
        const summaryTail = ffmpegOutput.slice(summaryIdx, summaryIdx + 600);
        console.log(`[mix-final] loudnorm summary:\n${summaryTail}`);
      }
    }

    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    const stat = fs.statSync(outputFile);
    console.log(`[mix-final] OK in ${dt}s, ${(stat.size / 1024 / 1024).toFixed(2)}MB`);

    const outputBuffer = fs.readFileSync(outputFile);
    fs.rmSync(tmpDir, { recursive: true, force: true });

    const mime = outputFormat === "wav" ? "audio/wav"
      : outputFormat === "mp3" ? "audio/mpeg"
      : "audio/aac";
    res.writeHead(200, {
      "Content-Type": mime,
      "Content-Length": outputBuffer.length,
      "X-Mix-Duration-Ms": String(durationMs),
      "X-Mix-Clip-Count": String(clips.length),
      "X-Mix-Loudness-Target-Lufs": loudnessTargetLufs != null ? String(loudnessTargetLufs) : "off",
    });
    return res.end(outputBuffer);

  } catch (err) {
    console.error("[mix-final] fatal:", err.message);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    res.writeHead(500);
    return res.end(JSON.stringify({ error: err.message }));
  }
}

module.exports = { registerMixFinal };

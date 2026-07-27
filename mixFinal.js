/* eslint-env node */
/* eslint-disable no-undef */
// /mix-final endpoint — enterprise multi-clip audio mixer.
//
// BATCHED HIERARCHICAL MIX (2026-06-26) — film/TV-scale durability fix.
// The previous single-pass design built ONE filter_complex with N clip chains
// feeding a single amix=inputs=N+1, with an apad on every clip extending it to
// the FULL program length before the mix clamped it. Peak memory therefore
// scaled with clips × timeline_duration: a 52-min project with 314 clips
// OOM-killed the FFmpeg process (empty stderr_tail = SIGKILL, no decode error),
// and a 90–120 min film with 600–900 clips would fail every time.
//
// New design mixes clips in BOUNDED BATCHES (BATCH_SIZE clips → one intermediate
// stem WAV each), then mixes the handful of intermediate stems + the M&E bed +
// the isolated-vocals bed into the final program. Peak memory is bounded by
// BATCH_SIZE, NOT total clip count — a 900-clip film uses the same peak memory
// as an 80-clip short. Summation is associative, so the output is bit-equivalent
// to the old single-pass mix: every clip keeps its identical
// atempo→atrim→fades→gain→adelay chain; batching only changes how the
// already-positioned clips are summed. Render parity (fades/trims/timing/
// loudnorm) is preserved exactly.
//
// FFmpeg runs via the non-blocking spawn helper (passed in from index.js) so a
// long film mix never freezes the event loop, and a failure surfaces the real
// signal/code (SIGKILL = OOM) instead of an opaque empty stderr_tail.
//
// Supports optional EBU R128 / ITU-R BS.1770 loudness normalization on the
// final program (post-mix, including M&E + vocals beds if present). Industry
// standard for broadcast and streaming deliverables (Netflix, Apple TV+, EBU, BBC).

const { spawn } = require("child_process");
const fs = require("fs");

// Max clips summed in a single intermediate FFmpeg pass. Keeps peak memory
// bounded regardless of total clip count. 80 is comfortably safe on a small
// Railway dyno (each pass decodes ≤80 short clips + a silent base, never the
// whole program-length apad fan-out the old design built). Tunable via the
// MIX_BATCH_SIZE env var without a code change.
const BATCH_SIZE = Math.max(10, Math.min(200, Number(process.env.MIX_BATCH_SIZE) || 80));

// Non-blocking ffmpeg runner. Rejects with a TRUTHFUL error that names the
// terminating signal (SIGKILL ⇒ almost always OOM on a big graph) and the last
// stderr — so a mix failure is never an opaque empty tail again. Mirrors the
// runFfmpeg helper in index.js but returns the captured stderr on success too
// (the caller logs the loudnorm summary from it).
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
      // signal SET (no exit code) = the kernel/OS killed the process. SIGKILL on
      // a large mix is the OOM signature. Surface it explicitly so the operator
      // sees "killed by SIGKILL (likely out of memory)" instead of empty tail.
      const tail = stderr.slice(-2000);
      const oom = signal === "SIGKILL" || signal === "SIGSEGV";
      const reason = signal
        ? `killed by ${signal}${oom ? " (likely out of memory)" : ""}`
        : `exited ${code}`;
      reject(Object.assign(
        new Error(`${label} ${reason}`),
        { kind: oom ? "oom" : "ffmpeg_error", signal, code, stderr_tail: tail },
      ));
    });
  });
}

// Route descriptor — registered once in index.js's single route table.
const routeMixFinal = { method: "POST", path: "/mix-final", handler: handleMixFinal };

// Build the per-clip filter chain (identical to the legacy single-pass design).
// Input label is [<inIdx>:a]; output label is [<outLabel>]. Pulled out so the
// batched intermediate passes and the (former) single pass share ONE source of
// truth for render parity.
function buildClipChain(c, inIdx, outLabel, sampleRate, fadeInSec, fadeOutSec) {
  const delay = Math.max(0, Math.round(Number(c.start_ms)));
  const gainDb = Number(c.gain_db) || 0;

  const rate = Number(c.playback_rate);
  const tempoPart = (Number.isFinite(rate) && rate > 0 && Math.abs(rate - 1) > 0.001)
    ? `atempo=${Math.max(0.5, Math.min(2.0, rate)).toFixed(4)},`
    : "";

  const maxDurMs = Number(c.max_duration_ms);
  const trimPart = (Number.isFinite(maxDurMs) && maxDurMs > 0)
    ? `atrim=end=${(maxDurMs / 1000).toFixed(4)},`
    : "";

  const fadeInPart = fadeInSec > 0 ? `afade=t=in:st=0:d=${fadeInSec}:curve=tri,` : "";
  const fadeOutPart = fadeOutSec > 0 ? `areverse,afade=t=in:st=0:d=${fadeOutSec}:curve=tri,areverse,` : "";

  return (
    `[${inIdx}:a]` +
    `aformat=sample_fmts=fltp:sample_rates=${sampleRate}:channel_layouts=stereo,` +
    tempoPart +
    trimPart +
    fadeInPart +
    fadeOutPart +
    (gainDb !== 0 ? `volume=${gainDb}dB,` : "") +
    `adelay=${delay}|${delay},` +
    `apad` +
    `[${outLabel}]`
  );
}

// Mix one batch of positioned clips into a single TC-locked intermediate WAV at
// the FULL program duration. The intermediate carries every clip already at its
// absolute timeline offset (adelay), so the final pass simply sums the
// intermediates with no further positioning. amix=duration=first clamps to the
// silent base (= program length). normalize=0 preserves levels (we sum, never
// average). 32-bit float PCM intermediates avoid any quantization loss across
// the two mix stages.
async function mixBatch(clips, durationSec, sampleRate, fadeInSec, fadeOutSec, outFile) {
  const args = ["-y", "-hide_banner", "-loglevel", "warning", "-nostdin"];
  // Silent base = program length. duration=first clamps the batch to it.
  args.push("-f", "lavfi", "-t", String(durationSec),
    "-i", `anullsrc=channel_layout=stereo:sample_rate=${sampleRate}`);
  for (const c of clips) args.push("-i", c.url);

  const filterParts = [`[0:a]aformat=sample_fmts=fltp:sample_rates=${sampleRate}:channel_layouts=stereo[base]`];
  const mixLabels = ["[base]"];
  for (let i = 0; i < clips.length; i++) {
    filterParts.push(buildClipChain(clips[i], i + 1, `c${i}`, sampleRate, fadeInSec, fadeOutSec));
    mixLabels.push(`[c${i}]`);
  }
  filterParts.push(
    `${mixLabels.join("")}amix=inputs=${mixLabels.length}:duration=first:normalize=0:dropout_transition=0[out]`,
  );

  const filterFile = `${outFile}.filter.txt`;
  fs.writeFileSync(filterFile, filterParts.join(";"));
  args.push("-filter_complex_script", filterFile, "-map", "[out]",
    "-c:a", "pcm_f32le", "-ar", String(sampleRate), "-ac", "2", outFile);

  await runFfmpeg(args, { label: `mix-batch(${clips.length} clips)` });
  try { fs.unlinkSync(filterFile); } catch (_) { /* best effort */ }
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
  // Original-language dialogue (isolated vocals) stem — the THIRD mixing-console
  // input. Optional and additive: present only when the operator's mix recipe
  // includes the original dialogue (bilingual QC, faint reference bed, etc.).
  const vocalsTrack = body.vocals_track || null;
  const durationMs = Number(body.duration_ms);
  const outputFormat = (body.output_format || "wav").toLowerCase();
  const sampleRate = Number(body.sample_rate || 48000);
  // Asymmetric micro-fades on every clip — must match the /time-stretch
  // fitting pass so the program mix never reintroduces a boundary pop the
  // fitted clips already suppressed. Defaults: 8ms in, 12ms out.
  const _legacyFade = body.fade_ms != null ? Number(body.fade_ms) : null;
  const fadeInMs = Math.max(0, Math.min(50, Number(body.fade_in_ms ?? _legacyFade ?? 8)));
  const fadeOutMs = Math.max(0, Math.min(50, Number(body.fade_out_ms ?? _legacyFade ?? 12)));

  // EBU R128 loudness normalization target (LUFS). -16 streaming / -23 broadcast
  // / null = no normalization. True-peak ceiling always -1 dBTP, LRA 11 LU.
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
  if (!["wav", "flac", "mp3", "aac"].includes(outputFormat)) { res.writeHead(400); return res.end(JSON.stringify({ error: "output_format must be wav, flac, mp3, or aac" })); }
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
  if (vocalsTrack && (typeof vocalsTrack !== "object" || typeof vocalsTrack.url !== "string")) {
    res.writeHead(400); return res.end(JSON.stringify({ error: "vocals_track.url required when vocals_track is set" }));
  }

  const tmpDir = `/tmp/mix_${Date.now()}`;
  fs.mkdirSync(tmpDir, { recursive: true });
  const outputFile = `${tmpDir}/out.${outputFormat}`;
  const durationSec = durationMs / 1000;
  const fadeInSec = fadeInMs / 1000;
  const fadeOutSec = fadeOutMs / 1000;

  try {
    const batchCount = Math.ceil(clips.length / BATCH_SIZE);
    console.log(`[mix-final] ${clips.length} clips in ${batchCount} batch(es) of ≤${BATCH_SIZE}, me=${!!meTrack}, vocals=${!!vocalsTrack}, dur=${durationMs}ms, fmt=${outputFormat}, sr=${sampleRate}, loudnorm=${loudnessTargetLufs ?? "off"}`);

    const t0 = Date.now();

    // ── STAGE 1: mix clips in bounded batches → intermediate TC-locked stems ──
    // Each intermediate is the full program length with its batch's clips
    // already at their absolute offsets. Peak memory is bounded by BATCH_SIZE.
    const intermediates = [];
    for (let b = 0; b < batchCount; b++) {
      const batch = clips.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
      const interFile = `${tmpDir}/inter_${b}.wav`;
      await mixBatch(batch, durationSec, sampleRate, fadeInSec, fadeOutSec, interFile);
      intermediates.push(interFile);
    }
    console.log(`[mix-final] stage 1 done: ${intermediates.length} intermediate stem(s) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    // ── STAGE 2: sum intermediate stems + M&E + vocals → final program ──
    // Every input here is already TC-locked at program length, so the final
    // pass is a pure sum (no positioning). With a single batch and no beds this
    // is just a format+trim of the one intermediate. Loudnorm (when requested)
    // runs once on the summed program — identical to the legacy behavior.
    const args2 = ["-y", "-hide_banner", "-loglevel", "warning", "-nostdin"];
    for (const f of intermediates) args2.push("-i", f);
    if (meTrack) args2.push("-i", meTrack.url);
    if (vocalsTrack) args2.push("-i", vocalsTrack.url);

    const filter2 = [];
    const sumLabels = [];
    for (let i = 0; i < intermediates.length; i++) {
      filter2.push(`[${i}:a]aformat=sample_fmts=fltp:sample_rates=${sampleRate}:channel_layouts=stereo[s${i}]`);
      sumLabels.push(`[s${i}]`);
    }
    let nextIdx = intermediates.length;
    if (meTrack) {
      const meGain = Number(meTrack.gain_db ?? -6);
      filter2.push(`[${nextIdx}:a]aformat=sample_fmts=fltp:sample_rates=${sampleRate}:channel_layouts=stereo,volume=${meGain}dB[me]`);
      sumLabels.push("[me]");
      nextIdx++;
    }
    if (vocalsTrack) {
      const vocalsGain = Number(vocalsTrack.gain_db ?? -18);
      filter2.push(`[${nextIdx}:a]aformat=sample_fmts=fltp:sample_rates=${sampleRate}:channel_layouts=stereo,volume=${vocalsGain}dB[vox]`);
      sumLabels.push("[vox]");
      nextIdx++;
    }
    filter2.push(`${sumLabels.join("")}amix=inputs=${sumLabels.length}:duration=first:normalize=0:dropout_transition=0[mix]`);

    const loudnormSuffix = loudnessTargetLufs != null
      ? `,loudnorm=I=${loudnessTargetLufs}:TP=-1:LRA=11:print_format=summary`
      : "";
    filter2.push(`[mix]atrim=0:${durationSec},asetpts=PTS-STARTPTS${loudnormSuffix}[out]`);

    const filterFile2 = `${tmpDir}/filter_final.txt`;
    fs.writeFileSync(filterFile2, filter2.join(";"));
    args2.push("-filter_complex_script", filterFile2, "-map", "[out]");

    if (outputFormat === "wav") {
      args2.push("-c:a", "pcm_s24le", "-ar", String(sampleRate), "-ac", "2");
    } else if (outputFormat === "flac") {
      // Lossless compressed deliverable — 24-bit FLAC (s32 input → 24 bps).
      args2.push("-c:a", "flac", "-sample_fmt", "s32", "-ar", String(sampleRate), "-ac", "2");
    } else if (outputFormat === "mp3") {
      args2.push("-c:a", "libmp3lame", "-b:a", "320k", "-ar", String(sampleRate), "-ac", "2");
    } else if (outputFormat === "aac") {
      args2.push("-c:a", "aac", "-b:a", "256k", "-ar", String(sampleRate), "-ac", "2");
    }
    args2.push(outputFile);

    const ffmpegStderr = await runFfmpeg(args2, { label: "mix-final" });

    // Free intermediates ASAP (each is a full-program-length float WAV).
    for (const f of intermediates) { try { fs.unlinkSync(f); } catch (_) { /* best effort */ } }

    // Log the loudnorm measured summary for auditor evidence (Railway logs).
    if (loudnessTargetLufs != null && ffmpegStderr) {
      const summaryIdx = ffmpegStderr.indexOf("Input Integrated");
      if (summaryIdx >= 0) {
        console.log(`[mix-final] loudnorm summary:\n${ffmpegStderr.slice(summaryIdx, summaryIdx + 600)}`);
      }
    }

    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    const stat = fs.statSync(outputFile);
    console.log(`[mix-final] OK in ${dt}s, ${(stat.size / 1024 / 1024).toFixed(2)}MB`);

    const outputBuffer = fs.readFileSync(outputFile);
    fs.rmSync(tmpDir, { recursive: true, force: true });

    const mime = outputFormat === "wav" ? "audio/wav"
      : outputFormat === "flac" ? "audio/flac"
      : outputFormat === "mp3" ? "audio/mpeg"
      : "audio/aac";
    res.writeHead(200, {
      "Content-Type": mime,
      "Content-Length": outputBuffer.length,
      "X-Mix-Duration-Ms": String(durationMs),
      "X-Mix-Clip-Count": String(clips.length),
      "X-Mix-Batch-Count": String(intermediates.length),
      "X-Mix-Loudness-Target-Lufs": loudnessTargetLufs != null ? String(loudnessTargetLufs) : "off",
    });
    return res.end(outputBuffer);

  } catch (err) {
    // TRUTHFUL failure (2026-06-26): when ffmpeg is OOM-killed the empty stderr
    // is no longer mistaken for a mystery — err.kind/signal name the real cause
    // so the operator sees "killed by SIGKILL (likely out of memory)" and the
    // export surface can advise. SOC 2 CC7.4 / CC8.1.
    const kind = err.kind || "fatal";
    const stderrTail = err.stderr_tail || "";
    console.error(`[mix-final] ${kind}:`, err.message, stderrTail ? `| tail: ${stderrTail.slice(-500)}` : "");
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    res.writeHead(500, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      error: kind === "oom"
        ? "ffmpeg failed: out of memory while mixing (the program was too large for a single pass)"
        : "ffmpeg failed",
      kind,
      signal: err.signal || null,
      stderr_tail: stderrTail,
      detail: err.message,
    }));
  }
}

module.exports = { routeMixFinal };

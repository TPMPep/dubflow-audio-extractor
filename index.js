/* eslint-env node */
/* eslint-disable no-undef */
const http = require("http");
const { spawn } = require("child_process");
const fs = require("fs");

// ── Async, non-blocking ffmpeg runner (SOC 2 CC7.2 — never freeze the loop) ──
// execSync blocks the single-threaded Node event loop for the ENTIRE ffmpeg run.
// While one /extract grinds, the whole service stalls — even /health stops
// responding and every concurrent request queues behind it. At 100+ users that
// is a hard wall. spawn() runs ffmpeg in a child process without blocking the
// loop, so the service stays responsive and handles concurrent extracts. The
// returned promise resolves on exit code 0 and rejects (with captured stderr)
// otherwise, with a hard timeout that kills a wedged child.
function runFfmpeg(args, { timeoutMs = 120000, label = "ffmpeg" } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch (_) { /* already gone */ }
      reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`${label} spawn failed: ${err.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${label} exited ${code}: ${stderr.slice(-500)}`));
    });
  });
}
// Zero-dependency WebCrypto SigV4 signer (replaces @aws-sdk/@smithy — incident
// 2026-07-07/08). STS session-token aware. See ./s3-signer.js.
const s3signer = require("./s3-signer");
const { presignS3Url, putS3Object, storageFromEnv, storageFromExplicit } = s3signer;
const { routeMixFinal } = require("./mixFinal");
const { routeMuxVideo } = require("./muxVideo");
const { routeProxyGen } = require("./proxyGenerator");
const { routeHlsIngest } = require("./hlsIngest");
const { routeHashFile } = require("./hashFile");
const { routeBurnSubtitles } = require("./burnSubtitles");
const { routeMeExtractUpload, routeMeDownloadToS3 } = require("./meExtractUpload");

// ── BOOT-TIME MODULE CONTRACT CHECK (enterprise-grade — SOC 2 CC7.2) ─────────
// THE universal fix for the class of failure that crash-looped this service on
// 2026-07-31: proxyGenerator.js was deployed with a NEW import
// (`createSemaphore` / `putS3ObjectStreaming` from ./s3-signer) while the
// deployed s3-signer.js was an OLDER copy that did not yet export them. Because
// plain CommonJS has NO compile step, `require('./s3-signer').createSemaphore`
// returned `undefined` and only threw `TypeError: createSemaphore is not a
// function` at RUNTIME, on the live production container, on the first heavy
// request — a split-deploy that boots straight into a crash loop.
//
// This asserts, AT BOOT, that every export the running code depends on actually
// EXISTS and is the right shape, BEFORE the HTTP server binds. If a required
// export is missing (a split-deploy where s3-signer.js is stale, a typo'd
// export, a bad merge), the process logs a LOUD, DIAGNOSTIC fatal naming the
// exact missing symbol and exits with code 1 — Railway then restarts, sees the
// same fatal, and the deploy is obviously, immediately broken with a message
// that says WHY. That is strictly better than a cryptic `is not a function`
// discovered by a user reporting a stuck proxy. Fail-fast + diagnostic, never a
// silent runtime landmine.
//
// CONTRACT: this is the single source of truth for "what must s3-signer.js
// export for this build to be internally consistent." Every function this
// service imports from s3-signer is listed here. Adding a new s3-signer import
// anywhere in the service means adding it here too — that is the discipline
// that makes split-deploy drift structurally impossible to reach production
// silently.
const REQUIRED_S3SIGNER_EXPORTS = [
  "presignS3Url",
  "putS3Object",
  "putS3ObjectStreaming", // streaming S3 upload — proxyGenerator.js
  "createSemaphore",      // heavy-lane gate       — proxyGenerator.js
  "storageFromEnv",
  "storageFromExplicit",
];

// Returns { ok, missing[] } — pure, so /health can reuse it without side effects.
function checkModuleContract() {
  const missing = REQUIRED_S3SIGNER_EXPORTS.filter(
    (name) => typeof s3signer[name] !== "function",
  );
  return { ok: missing.length === 0, missing };
}

// Enforce at boot — BEFORE the server binds. A stale/half-matched deploy exits
// loud instead of crash-looping on the first heavy request.
{
  const contract = checkModuleContract();
  if (!contract.ok) {
    console.error(
      `[FATAL] Module contract violation — s3-signer.js is missing required export(s): ${contract.missing.join(", ")}. ` +
      `This is a SPLIT-DEPLOY: the running code imports symbols the deployed s3-signer.js does not export. ` +
      `Deploy s3-signer.js + proxyGenerator.js + index.js TOGETHER from the same commit. Exiting.`,
    );
    process.exit(1);
  }
}
// Concurrency gate REVERTED 2026-07-31. The bounded-pool gate made heavy
// synchronous routes (/mix-final, /mux-video, /generate-proxy-sync, etc.) wait
// SILENTLY in a FIFO queue for up to 10 min when saturated. Every one of those
// routes is fronted by Railway's Cloudflare edge, which kills any connection
// that sends zero bytes for ~100s with a 524 — so a queued export 524'd before
// it ever started rendering. The gate's acquire ceiling (10 min) was ~6× longer
// than the edge tolerates a silent connection, so the queue-wait could never be
// used; it only ever manifested as a 524. Reverted to the pre-gate behavior:
// every route starts immediately and streams, exactly as it did before the gate
// was introduced. The original unbounded-concurrency wedge risk returns, but it
// was rare/intermittent and never as severe as the gate-induced 524s.

const BUCKET = process.env.S3_BUCKET || "pep-test";
const AWS_REGION = process.env.AWS_REGION || "us-west-2";
const API_KEY = process.env.API_KEY || "change-me";

// This service's own storage handle (self creds from env, STS-aware). Built
// once — the resolved creds/region/bucket don't change per request.
const storage = storageFromEnv({ region: AWS_REGION, bucket: BUCKET });

// Build tag — bumped whenever this service changes so /health self-reports the
// running build. Lets us verify a Railway redeploy actually landed (the same
// /health-build-tag verification pattern the BullMQ worker uses) before relying
// on a code path. This build converts the fragile listener-swapping route
// registration into a single explicit route table (see the router below).
const BUILD_TAG = "extractor-2026-08-01-me-harvest-streaming";

// ── Non-blocking ffprobe (SOC 2 CC7.2 — never freeze the loop) ──
// execSync(ffprobe) blocks the single-threaded event loop for the whole probe.
// A slow/large/remote input therefore freezes EVERY concurrent request — even
// /health stops answering (the exact "it goes down again" symptom). This runs
// ffprobe via spawn and resolves the trimmed stdout, with a hard timeout that
// kills a wedged child. Returns "" on any non-zero exit so callers can treat a
// failed probe as "unknown duration" without a throw.
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

// =============================================================================
// SINGLE EXPLICIT ROUTE TABLE (enterprise-grade — SOC 2 CC7.2).
// -----------------------------------------------------------------------------
// The OLD design had each module (mixFinal / muxVideo / proxyGen / hlsIngest /
// hashFile / burnSubtitles) call server.removeAllListeners("request") and
// re-add a wrapper that chained to the previous listener(s). That was a latent
// production race under 100+ concurrent users: the async base handler could
// send a 404 (or a matched handler could respond) while a chained wrapper ALSO
// wrote to the same `res`, throwing ERR_HTTP_HEADERS_SENT and dropping the
// request. Worse, proxyGenerator/hlsIngest/hashFile chained only
// listeners("request")[0] (a SINGLE listener), so registration order silently
// determined whether /mix-final and /mux-video even stayed reachable.
//
// This replaces ALL of it with ONE request handler and ONE route table. Every
// route — inline handlers here + the six module routes — is a
// { method, path, handler } descriptor dispatched by an O(1) Map lookup. No
// listener is ever removed or chained; each request is handled EXACTLY ONCE, so
// the ERR_HTTP_HEADERS_SENT race is structurally impossible. Every endpoint's
// behavior is byte-for-byte unchanged — only the dispatch mechanism moved.
// =============================================================================
const routes = new Map();
// Each route is registered directly — NO concurrency gate (reverted 2026-07-31).
// Every handler starts immediately and streams its response, exactly as it did
// before the bounded-pool gate was introduced. This is the pre-gate behavior
// that let exports of any length complete without a Cloudflare 524.
function route(descriptor) {
  routes.set(`${descriptor.method} ${descriptor.path}`, descriptor.handler);
}

// ── Extract speaker audio segments ──
async function handleExtract(req, res, API_KEY) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());

  if (body.api_key !== API_KEY) {
    res.writeHead(401);
    return res.end(JSON.stringify({ error: "Unauthorized" }));
  }

  const { s3_key, timestamps, speaker_label } = body;
  if (!s3_key || !timestamps || timestamps.length === 0) {
    res.writeHead(400);
    return res.end(JSON.stringify({ error: "s3_key and timestamps required" }));
  }

  try {
    console.log(`Extracting audio for ${speaker_label || "speaker"} from ${s3_key}, ${timestamps.length} segments`);

    const signedUrl = await presignS3Url({ method: "GET", storage, key: s3_key, expiresIn: 3600 });

    const tmpDir = `/tmp/${Date.now()}`;
    fs.mkdirSync(tmpDir, { recursive: true });
    const outputFile = `${tmpDir}/output.wav`;

    // ── SINGLE-PASS FAST-SEEK EXTRACT (enterprise-grade) ──────────────────
    // Old approach: one ffmpeg per segment, each re-opening the full remote
    // MP4 with -ss AFTER -i (slow decode-seek from the file start every time).
    // For a 50-min source × 60+ segments that blew past every timeout and
    // blocked the event loop. New approach opens the remote file ONCE and
    // pulls every window in a single ffmpeg invocation:
    //   • Each window is its own input with -ss BEFORE -i (fast index seek —
    //     ffmpeg jumps via the container index instead of decoding from 0).
    //   • -t bounds each input to the window length.
    //   • An amix-free concat filtergraph ([a0][a1]...concat=n=N:v=0:a=1)
    //     stitches the windows in order into one mono 44.1kHz PCM WAV — the
    //     exact same output shape ElevenLabs cloning expects.
    // Result: tens of seconds → low single digits, and it no longer freezes
    // the service for concurrent callers.
    const valid = timestamps.filter(
      (t) => t && t.start_ms != null && t.end_ms != null && t.end_ms > t.start_ms,
    );
    if (valid.length === 0) throw new Error("No valid timestamp windows provided");

    const inputArgs = [];
    const filterParts = [];
    valid.forEach((t, i) => {
      const startSec = (t.start_ms / 1000).toFixed(3);
      const durSec = ((t.end_ms - t.start_ms) / 1000).toFixed(3);
      // -ss before -i = fast input seek; -t bounds the window.
      inputArgs.push("-ss", startSec, "-t", durSec, "-i", signedUrl);
      // Resample each window to a uniform format before concat so a
      // variable-rate source can't desync the filtergraph.
      filterParts.push(`[${i}:a]aresample=44100,aformat=channel_layouts=mono[a${i}]`);
    });
    const concatInputs = valid.map((_, i) => `[a${i}]`).join("");
    const filterGraph = `${filterParts.join(";")};${concatInputs}concat=n=${valid.length}:v=0:a=1[out]`;

    // ── DECODER-INIT HARDENING (2026-07-31) ───────────────────────────────
    // A speaker with many segments opens MANY inputs at once — one decoder per
    // -i (a busy speaker = 25+ concurrent FLAC decoders). When several /extract
    // jobs run simultaneously (a user clicking Clone speaker-to-speaker rapidly,
    // or a future batch), FFmpeg's per-decoder auto-thread pools race for OS
    // threads inside the constrained Railway container and fail decoder init
    // with the errno-EAGAIN message: "Error while opening decoder for input
    // stream #N:0 : Resource temporarily unavailable". It's intermittent (a
    // contention race, NOT a bad file) — which is exactly why a retry a moment
    // later succeeds. `-threads 1` forces SINGLE-THREADED decoder init so every
    // decoder opens deterministically without competing for a thread pool (the
    // same fix already proven on the proxy decode path). It is a DECODE-side
    // flag only — the pcm output is trivial to encode, so this does not slow the
    // extract. `-fflags +genpts` + `-err_detect ignore_err` tolerate a benign
    // per-input timestamp/stream quirk so one flaky window can't abort the whole
    // multi-input concat. SOC 2 CC7.2 — the extract is resilient under concurrency.
    const ffmpegArgs = [
      "-y",
      "-threads", "1",
      "-fflags", "+genpts",
      "-err_detect", "ignore_err",
      ...inputArgs,
      "-filter_complex", filterGraph,
      "-map", "[out]",
      "-acodec", "pcm_s16le",
      "-ar", "44100",
      "-ac", "1",
      outputFile,
    ];
    await runFfmpeg(ffmpegArgs, { timeoutMs: 110000, label: "Audio extraction" });

    const audioBuffer = fs.readFileSync(outputFile);
    const sizeMB = (audioBuffer.length / 1024 / 1024).toFixed(1);
    console.log(`Extracted ${sizeMB}MB audio (${valid.length} segments, single-pass)`);

    const outputKey = `dubflow/voice-clones/${speaker_label || "speaker"}_${Date.now()}.wav`;
    await putS3Object(storage, outputKey, audioBuffer, { contentType: "audio/wav" });

    const audioSignedUrl = await presignS3Url({ method: "GET", storage, key: outputKey, expiresIn: 3600 });

    fs.rmSync(tmpDir, { recursive: true, force: true });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      success: true,
      s3_key: outputKey,
      signed_url: audioSignedUrl,
      size_mb: parseFloat(sizeMB),
      segment_count: valid.length,
    }));

  } catch (err) {
    console.error("Extraction error:", err.message);
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  }
}

// ── Time-stretch audio to fit a target duration ──
async function handleTimeStretch(req, res, API_KEY) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());

  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.replace("Bearer ", "");
  if (token !== API_KEY && body.api_key !== API_KEY) {
    res.writeHead(401);
    return res.end(JSON.stringify({ error: "Unauthorized" }));
  }

  // output_format: "mp3" (legacy default, back-compat for old callers) or
  // "wav" (lossless pipeline — pcm_s16le, no generational re-encode loss).
  const { audio_url, target_duration_sec, output_format = "mp3" } = body;
  const tsOutFmt = output_format === "wav" ? "wav" : "mp3";
  if (!audio_url || !target_duration_sec) {
    res.writeHead(400);
    return res.end(JSON.stringify({ error: "audio_url and target_duration_sec required" }));
  }

  // Universal micro-fades (enterprise-grade pop suppression). This endpoint
  // is THE single fitting pass for every dubbed clip — whether it stretches
  // (overshoot) or re-encodes at 1.0x tempo (natural fit / no-stretch). Both
  // paths emerge with identical in/out fades so there is exactly ONE place
  // fades are ever baked. Optional overrides let the caller tune per clip,
  // but the defaults are the production contract: 8ms in, 12ms out.
  //   • 8ms fade-in  — kills the leading transient click on hard onsets.
  //   • 12ms fade-out — bumped from a shorter tail because near-peak signal
  //     at the clip end is the dominant audible "pop"; 12ms fully resolves
  //     it without eating perceptible speech.
  // Fades are tri (linear) curves — phase-neutral, no DC offset.
  const fadeInSec = Math.max(0, Number(body.fade_in_ms ?? 8)) / 1000;
  const fadeOutSec = Math.max(0, Number(body.fade_out_ms ?? 12)) / 1000;

  const tmpDir = `/tmp/stretch_${Date.now()}`;
  fs.mkdirSync(tmpDir, { recursive: true });
  // Extension-less input — ffmpeg content-probes the real container (the
  // lossless pipeline sends WAV; legacy clips are MP3). Never let a wrong
  // extension steer the demuxer.
  const inputFile = `${tmpDir}/input`;
  const outputFile = `${tmpDir}/output.${tsOutFmt}`;

  try {
    console.log(`Time-stretching audio to ${target_duration_sec}s`);

    const downloadRes = await fetch(audio_url);
    if (!downloadRes.ok) throw new Error(`Download failed: ${downloadRes.status}`);
    const audioArrayBuffer = await downloadRes.arrayBuffer();
    fs.writeFileSync(inputFile, Buffer.from(audioArrayBuffer));

    const probeResult = await runFfprobe(
      ["-v", "quiet", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", inputFile],
    );

    const originalDuration = parseFloat(probeResult);
    if (!originalDuration || originalDuration <= 0) {
      throw new Error("Could not determine audio duration");
    }

    const ratio = originalDuration / target_duration_sec;
    console.log(`Original: ${originalDuration.toFixed(2)}s, Target: ${target_duration_sec}s, Ratio: ${ratio.toFixed(3)}`);

    const filters = [];
    let remaining = ratio;
    while (remaining > 2.0) {
      filters.push("atempo=2.0");
      remaining /= 2.0;
    }
    while (remaining < 0.5) {
      filters.push("atempo=0.5");
      remaining /= 0.5;
    }
    filters.push(`atempo=${remaining.toFixed(6)}`);

    // Append micro-fades AFTER the atempo chain so the fade durations are in
    // real output-time seconds (atempo changes duration; fades must measure
    // against the final timeline). The fade-out start is computed from the
    // TARGET duration since that's the post-stretch length. Guard against
    // degenerate windows shorter than the fades themselves.
    const fadeOutStartSec = Math.max(0, target_duration_sec - fadeOutSec);
    if (fadeInSec > 0 && target_duration_sec > fadeInSec * 2) {
      filters.push(`afade=t=in:st=0:d=${fadeInSec.toFixed(4)}:curve=tri`);
    }
    if (fadeOutSec > 0 && target_duration_sec > fadeOutSec * 2) {
      filters.push(`afade=t=out:st=${fadeOutStartSec.toFixed(4)}:d=${fadeOutSec.toFixed(4)}:curve=tri`);
    }
    const filterStr = filters.join(",");

    console.log(`FFmpeg filter: ${filterStr}`);

    // Lossless path encodes pcm_s16le WAV; legacy path keeps lame MP3.
    const tsCodecArgs = tsOutFmt === "wav" ? ["-c:a", "pcm_s16le"] : ["-c:a", "libmp3lame", "-q:a", "2"];
    await runFfmpeg(
      ["-y", "-i", inputFile, "-filter:a", filterStr, "-vn", ...tsCodecArgs, outputFile],
      { timeoutMs: 30000, label: "Time-stretch" },
    );

    const stretchedBuffer = fs.readFileSync(outputFile);
    console.log(`Stretched audio: ${(stretchedBuffer.length / 1024).toFixed(0)}KB`);

    // Duration-truthing headers (Tier 2, 2026-06-08). Probe the ACTUAL
    // FFmpeg output so the caller can store the measured fitted length
    // instead of trusting the requested target. The input duration was
    // already probed above (originalDuration). Both are emitted as response
    // HEADERS so the body stays binary audio — zero contract break for
    // callers that ignore them. ffprobe on the output must NEVER fail the
    // (already-successful) audio response: a probe error degrades the
    // output-duration header to absent, not the whole request.
    const durationHeaders = {};
    if (Number.isFinite(originalDuration) && originalDuration > 0) {
      durationHeaders["X-Input-Duration-Ms"] = String(Math.round(originalDuration * 1000));
    }
    const outProbe = await runFfprobe(
      ["-v", "quiet", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", outputFile],
    );
    const outDurationSec = parseFloat(outProbe);
    if (Number.isFinite(outDurationSec) && outDurationSec > 0) {
      durationHeaders["X-Output-Duration-Ms"] = String(Math.round(outDurationSec * 1000));
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });

    res.writeHead(200, { "Content-Type": tsOutFmt === "wav" ? "audio/wav" : "audio/mpeg", ...durationHeaders });
    res.end(stretchedBuffer);

  } catch (err) {
    console.error("Time-stretch error:", err.message);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  }
}

// ── Process audio with custom FFmpeg filters (supports extra_args for seeking) ──
async function handleProcess(req, res, API_KEY) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());

  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.replace("Bearer ", "");
  if (token !== API_KEY && body.api_key !== API_KEY) {
    res.writeHead(401);
    return res.end(JSON.stringify({ error: "Unauthorized" }));
  }

  const { source_url, filters, output_format = "mp3", extra_args = "" } = body;
  if (!source_url || !filters) {
    res.writeHead(400);
    return res.end(JSON.stringify({ error: "source_url and filters required" }));
  }

  const tmpDir = `/tmp/process_${Date.now()}`;
  fs.mkdirSync(tmpDir, { recursive: true });
  const inputFile = `${tmpDir}/input`;
  const outputFile = `${tmpDir}/output.${output_format}`;

  try {
    console.log(`[process] Applying filters: ${filters}, extra_args: ${extra_args || "(none)"}`);

    // Download source
    const downloadRes = await fetch(source_url);
    if (!downloadRes.ok) throw new Error(`Download failed: ${downloadRes.status}`);
    const audioArrayBuffer = await downloadRes.arrayBuffer();
    fs.writeFileSync(inputFile, Buffer.from(audioArrayBuffer));
    console.log(`[process] Downloaded ${(audioArrayBuffer.byteLength / 1024 / 1024).toFixed(1)} MB`);

    // Parse extra_args to separate input flags (-ss, -t, -vn, -ac, -b:a, etc.)
    // -ss and -t go BEFORE -i for fast seeking; the rest go after
    const inputFlags = [];  // before -i (seeking)
    const outputFlags = []; // after -i (codec/format)
    if (extra_args) {
      const parts = extra_args.trim().split(/\s+/);
      let i = 0;
      while (i < parts.length) {
        const flag = parts[i];
        if (flag === "-ss" || flag === "-t") {
          // These are input flags — put before -i for fast seeking
          inputFlags.push(flag, parts[i + 1] || "");
          i += 2;
        } else if (flag === "-vn") {
          // No video — output flag
          outputFlags.push(flag);
          i += 1;
        } else if (flag === "-ac" || flag === "-b:a" || flag === "-ar" || flag === "-acodec") {
          // Codec/format flags with a value — output flags
          outputFlags.push(flag, parts[i + 1] || "");
          i += 2;
        } else {
          // Unknown flag — treat as output flag
          outputFlags.push(flag);
          i += 1;
        }
      }
    }

    const inputFlagsStr = inputFlags.length > 0 ? inputFlags.join(" ") + " " : "";
    const outputFlagsStr = outputFlags.length > 0 ? " " + outputFlags.join(" ") : "";

    // Build FFmpeg command — codec follows the requested output_format.
    // The codec is chosen HERE by output_format, never smuggled in via
    // extra_args (a caller-supplied "-c:a X" would collide with this append
    // and produce a fatal duplicate "-c:a" — the M&E FLAC-extract bug). The
    // extra_args parser above intentionally routes -acodec/-c:a into
    // outputFlags, so any codec a caller passes there would double up; we own
    // the codec exclusively via this switch.
    //   wav  → pcm_s16le (lossless identity-shift path)
    //   flac → native FLAC (lossless M&E High-fidelity source extract)
    //   else → lame MP3 (default)
    const procCodecArgs = output_format === "wav"
      ? "-c:a pcm_s16le"
      : output_format === "flac"
        ? "-c:a flac"
        : "-c:a libmp3lame -q:a 2";
    // Build the arg array (spawn — non-blocking). inputFlags go before -i,
    // outputFlags + codec after. procCodecArgs is a string pair we split.
    const procArgs = [
      "-y",
      ...inputFlags,
      "-i", inputFile,
      "-af", filters,
      ...outputFlags,
      ...procCodecArgs.split(" "),
      outputFile,
    ];
    console.log(`[process] Running: ffmpeg ${procArgs.join(" ")}`);
    await runFfmpeg(procArgs, { timeoutMs: 120000, label: "Process" });

    const outputBuffer = fs.readFileSync(outputFile);
    console.log(`[process] Output: ${(outputBuffer.length / 1024).toFixed(0)}KB`);

    // Duration-truthing header (Tier 2, 2026-06-08). /process is the
    // identity-shift output path; probe the actual output so the caller can
    // store the MEASURED raw-dub length instead of the byteLength/16000
    // estimate. Emitted as a response HEADER so the binary body contract is
    // untouched. ffprobe failure is non-fatal — degrades to absent header.
    const processDurationHeaders = {};
    const procProbe = await runFfprobe(
      ["-v", "quiet", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", outputFile],
    );
    const procDurationSec = parseFloat(procProbe);
    if (Number.isFinite(procDurationSec) && procDurationSec > 0) {
      processDurationHeaders["X-Output-Duration-Ms"] = String(Math.round(procDurationSec * 1000));
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
    res.writeHead(200, { "Content-Type": `audio/${output_format}`, ...processDurationHeaders });
    res.end(outputBuffer);
  } catch (err) {
    console.error("[process] Error:", err.message);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  }
}

// ── Trim audio to a precise window with optional fades ──
// POST /trim { audio_url, start_ms, end_ms, fade_in_ms?, fade_out_ms?, output_format? }
// Returns the trimmed audio file binary directly (Content-Type: audio/<format>).
// Used by pickup-line recording flow to remove dead air based on AssemblyAI word timings
// OR based on user-dragged trim handles in the preview sandbox.
async function handleTrim(req, res, API_KEY) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());

  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.replace("Bearer ", "");
  if (token !== API_KEY && body.api_key !== API_KEY) {
    res.writeHead(401);
    return res.end(JSON.stringify({ error: "Unauthorized" }));
  }

  const {
    audio_url,
    start_ms,
    end_ms,
    fade_in_ms = 30,
    fade_out_ms = 50,
    output_format = "mp3",
  } = body;

  if (!audio_url || start_ms == null || end_ms == null) {
    res.writeHead(400);
    return res.end(JSON.stringify({ error: "audio_url, start_ms, end_ms required" }));
  }
  if (end_ms <= start_ms) {
    res.writeHead(400);
    return res.end(JSON.stringify({ error: "end_ms must be greater than start_ms" }));
  }

  const tmpDir = `/tmp/trim_${Date.now()}`;
  fs.mkdirSync(tmpDir, { recursive: true });
  const inputFile = `${tmpDir}/input`;
  const outputFile = `${tmpDir}/output.${output_format}`;

  try {
    const startSec = (start_ms / 1000).toFixed(3);
    const durationMs = end_ms - start_ms;
    const durationSec = (durationMs / 1000).toFixed(3);
    const fadeInSec = (fade_in_ms / 1000).toFixed(3);
    const fadeOutSec = (fade_out_ms / 1000).toFixed(3);
    const fadeOutStartSec = ((durationMs - fade_out_ms) / 1000).toFixed(3);

    console.log(`[trim] start=${startSec}s dur=${durationSec}s fadeIn=${fadeInSec}s fadeOut=${fadeOutSec}s`);

    const downloadRes = await fetch(audio_url);
    if (!downloadRes.ok) throw new Error(`Download failed: ${downloadRes.status}`);
    const audioArrayBuffer = await downloadRes.arrayBuffer();
    fs.writeFileSync(inputFile, Buffer.from(audioArrayBuffer));

    // Only apply fades if window is long enough to fit them comfortably
    const totalSec = parseFloat(durationSec);
    const filters = [];
    if (fade_in_ms > 0 && totalSec > parseFloat(fadeInSec) * 2) {
      filters.push(`afade=t=in:st=0:d=${fadeInSec}`);
    }
    if (fade_out_ms > 0 && totalSec > parseFloat(fadeOutSec) * 2) {
      filters.push(`afade=t=out:st=${fadeOutStartSec}:d=${fadeOutSec}`);
    }
    const filterArgs = filters.length > 0 ? ["-af", filters.join(",")] : [];

    const trimArgs = [
      "-y", "-ss", startSec, "-t", durationSec, "-i", inputFile,
      ...filterArgs, "-c:a", "libmp3lame", "-q:a", "2", "-ac", "1", "-ar", "44100", outputFile,
    ];
    console.log(`[trim] Running: ffmpeg ${trimArgs.join(" ")}`);
    await runFfmpeg(trimArgs, { timeoutMs: 30000, label: "Trim" });

    const outputBuffer = fs.readFileSync(outputFile);
    console.log(`[trim] Output: ${(outputBuffer.length / 1024).toFixed(0)}KB, dur=${durationSec}s`);

    fs.rmSync(tmpDir, { recursive: true, force: true });
    res.writeHead(200, { "Content-Type": `audio/${output_format}` });
    res.end(outputBuffer);
  } catch (err) {
    console.error("[trim] Error:", err.message);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  }
}

// ── Auto-detect dead air (silence) at the head and tail of an audio clip ──
// POST /silence-detect { audio_url, silence_threshold_db?, min_silence_duration_sec? }
// Returns: { duration_sec, leading_silence_sec, trailing_silence_sec,
//            speech_start_sec, speech_end_sec, silences: [...] }
// Used by the pickup-line preview sandbox to suggest a smart auto-trim window
// when AssemblyAI word timings aren't precise enough (or as a sanity check on them).
async function handleSilenceDetect(req, res, API_KEY) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());

  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.replace("Bearer ", "");
  if (token !== API_KEY && body.api_key !== API_KEY) {
    res.writeHead(401);
    return res.end(JSON.stringify({ error: "Unauthorized" }));
  }

  const {
    audio_url,
    silence_threshold_db = -35,    // anything quieter than -35dBFS is "silence"
    min_silence_duration_sec = 0.3, // ignore silences shorter than 300ms
  } = body;

  if (!audio_url) {
    res.writeHead(400);
    return res.end(JSON.stringify({ error: "audio_url required" }));
  }

  const tmpDir = `/tmp/silence_${Date.now()}`;
  fs.mkdirSync(tmpDir, { recursive: true });
  const inputFile = `${tmpDir}/input`;

  try {
    console.log(`[silence-detect] threshold=${silence_threshold_db}dB min=${min_silence_duration_sec}s`);

    const downloadRes = await fetch(audio_url);
    if (!downloadRes.ok) throw new Error(`Download failed: ${downloadRes.status}`);
    const audioArrayBuffer = await downloadRes.arrayBuffer();
    fs.writeFileSync(inputFile, Buffer.from(audioArrayBuffer));

    // Get total duration (non-blocking probe)
    const probeOut = await runFfprobe(
      ["-v", "quiet", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", inputFile],
    );
    const durationSec = parseFloat(probeOut);
    if (!durationSec || durationSec <= 0) throw new Error("Could not determine audio duration");

    // Run silencedetect via spawn (non-blocking) — the measurements are printed
    // to stderr, so we capture it (ffmpeg exits 0 here; a null muxer produces no
    // file). This never freezes the event loop for concurrent callers.
    const stderr = await new Promise((resolve) => {
      const child = spawn("ffmpeg",
        ["-i", inputFile, "-af", `silencedetect=noise=${silence_threshold_db}dB:d=${min_silence_duration_sec}`, "-f", "null", "-"],
        { stdio: ["ignore", "ignore", "pipe"] });
      let buf = "";
      let settled = false;
      const done = () => { if (settled) return; settled = true; clearTimeout(timer); resolve(buf); };
      const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch (_) { /* gone */ } done(); }, 30000);
      child.stderr.on("data", (d) => { buf += d.toString(); });
      child.on("error", done);
      child.on("close", done);
    });

    // Parse silence_start / silence_end pairs
    const silenceStartRegex = /silence_start:\s*([\d.]+)/g;
    const silenceEndRegex = /silence_end:\s*([\d.]+)/g;
    const silences = [];
    const starts = [];
    const ends = [];
    let m;
    while ((m = silenceStartRegex.exec(stderr)) !== null) starts.push(parseFloat(m[1]));
    while ((m = silenceEndRegex.exec(stderr)) !== null) ends.push(parseFloat(m[1]));
    for (let i = 0; i < starts.length; i++) {
      const s = starts[i];
      const e = ends[i] != null ? ends[i] : durationSec; // trailing silence has no end
      silences.push({ start_sec: +s.toFixed(3), end_sec: +e.toFixed(3), duration_sec: +(e - s).toFixed(3) });
    }

    // Leading silence: from 0 to start of first non-silence
    const leadingSilence = (silences.length > 0 && silences[0].start_sec < 0.05)
      ? silences[0].duration_sec
      : 0;

    // Trailing silence: from end of last non-silence to duration
    const lastSilence = silences[silences.length - 1];
    const trailingSilence = (lastSilence && Math.abs(lastSilence.end_sec - durationSec) < 0.05)
      ? lastSilence.duration_sec
      : 0;

    const speechStart = leadingSilence;
    const speechEnd = durationSec - trailingSilence;

    console.log(`[silence-detect] dur=${durationSec.toFixed(2)}s speech=${speechStart.toFixed(2)}s-${speechEnd.toFixed(2)}s silences=${silences.length}`);

    fs.rmSync(tmpDir, { recursive: true, force: true });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      duration_sec: +durationSec.toFixed(3),
      leading_silence_sec: +leadingSilence.toFixed(3),
      trailing_silence_sec: +trailingSilence.toFixed(3),
      speech_start_sec: +speechStart.toFixed(3),
      speech_end_sec: +speechEnd.toFixed(3),
      silences,
    }));
  } catch (err) {
    console.error("[silence-detect] Error:", err.message);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  }
}

// ── Normalize a voice sample for ElevenLabs cloning ──
// Downloads source from a signed URL, runs denoise + loudness normalization,
// uploads the result as 44.1kHz mono 16-bit WAV back to S3.
async function handleNormalizeVoiceSample(req, res, API_KEY) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());

  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.replace("Bearer ", "");
  if (token !== API_KEY && body.api_key !== API_KEY) {
    res.writeHead(401);
    return res.end(JSON.stringify({ error: "Unauthorized" }));
  }

  const {
    source_signed_url,
    target_bucket,
    target_key,
    aws_region,
    aws_access_key_id,
    aws_secret_access_key,
    aws_session_token,   // optional — present only for temporary STS creds
    ffmpeg_filter = "afftdn=nr=12,highpass=f=80,loudnorm=I=-16:TP=-1.5:LRA=11",
  } = body;

  if (!source_signed_url || !target_bucket || !target_key) {
    res.writeHead(400);
    return res.end(JSON.stringify({ error: "source_signed_url, target_bucket, target_key required" }));
  }

  const tmpDir = `/tmp/normalize_${Date.now()}`;
  fs.mkdirSync(tmpDir, { recursive: true });
  const inputFile = `${tmpDir}/input`;
  const outputFile = `${tmpDir}/output.wav`;

  try {
    console.log(`[normalize] Fetching source for normalization`);
    const downloadRes = await fetch(source_signed_url);
    if (!downloadRes.ok) throw new Error(`Download failed: ${downloadRes.status}`);
    const audioArrayBuffer = await downloadRes.arrayBuffer();
    fs.writeFileSync(inputFile, Buffer.from(audioArrayBuffer));
    console.log(`[normalize] Downloaded ${(audioArrayBuffer.byteLength / 1024 / 1024).toFixed(2)} MB`);

    // Denoise + loudnorm → mono 44.1kHz 16-bit PCM WAV (ideal for ElevenLabs cloning)
    await runFfmpeg(
      ["-y", "-i", inputFile, "-af", ffmpeg_filter, "-ac", "1", "-ar", "44100", "-sample_fmt", "s16", "-c:a", "pcm_s16le", outputFile],
      { timeoutMs: 120000, label: "Normalize" },
    );

    // Probe duration (non-blocking)
    const probeResult = await runFfprobe(
      ["-v", "quiet", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", outputFile],
    );
    const durationSec = parseFloat(probeResult) || 0;

    const outputBuffer = fs.readFileSync(outputFile);
    console.log(`[normalize] Output: ${(outputBuffer.length / 1024).toFixed(0)}KB, ${durationSec.toFixed(2)}s`);

    // Upload to the caller's bucket using THEIR credentials (so writes stay
    // within Base44's AWS account, not this service's). STS-aware: if the
    // caller forwards a temporary session token it is signed alongside.
    const callerStorage = storageFromExplicit({
      region: aws_region || AWS_REGION,
      bucket: target_bucket,
      accessKeyId: aws_access_key_id,
      secretAccessKey: aws_secret_access_key,
      sessionToken: aws_session_token,
    });

    await putS3Object(callerStorage, target_key, outputBuffer, { contentType: "audio/wav" });

    fs.rmSync(tmpDir, { recursive: true, force: true });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      duration_ms: Math.round(durationSec * 1000),
      size_bytes: outputBuffer.length,
    }));
  } catch (err) {
    console.error("[normalize] Error:", err.message);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  }
}

// ── Concatenate multiple audio files ──
async function handleConcat(req, res, API_KEY) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());

  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.replace("Bearer ", "");
  if (token !== API_KEY && body.api_key !== API_KEY) {
    res.writeHead(401);
    return res.end(JSON.stringify({ error: "Unauthorized" }));
  }

  const { audio_urls, output_format = "mp3" } = body;
  if (!audio_urls || !Array.isArray(audio_urls) || audio_urls.length === 0) {
    res.writeHead(400);
    return res.end(JSON.stringify({ error: "audio_urls array required" }));
  }

  const tmpDir = `/tmp/concat_${Date.now()}`;
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    console.log(`[concat] Concatenating ${audio_urls.length} files`);

    const inputFiles = [];
    for (let i = 0; i < audio_urls.length; i++) {
      const dlRes = await fetch(audio_urls[i]);
      if (!dlRes.ok) throw new Error(`Download failed for file ${i}: ${dlRes.status}`);
      const buf = Buffer.from(await dlRes.arrayBuffer());
      const filePath = `${tmpDir}/part_${i}.mp3`;
      fs.writeFileSync(filePath, buf);
      inputFiles.push(filePath);
      console.log(`[concat] Downloaded part ${i}: ${(buf.length / 1024).toFixed(0)}KB`);
    }

    const listFile = `${tmpDir}/list.txt`;
    fs.writeFileSync(listFile, inputFiles.map(f => `file '${f}'`).join("\n"));

    const outputFile = `${tmpDir}/output.${output_format}`;
    await runFfmpeg(
      ["-f", "concat", "-safe", "0", "-i", listFile, "-c:a", "libmp3lame", "-q:a", "2", "-y", outputFile],
      { timeoutMs: 120000, label: "Concat" },
    );

    const outputBuffer = fs.readFileSync(outputFile);
    console.log(`[concat] Output: ${(outputBuffer.length / 1024).toFixed(0)}KB`);

    fs.rmSync(tmpDir, { recursive: true, force: true });
    res.writeHead(200, { "Content-Type": `audio/${output_format}` });
    res.end(outputBuffer);
  } catch (err) {
    console.error("[concat] Error:", err.message);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  }
}

// ─── Register every route ONCE in the single route table ──────────────────
// Inline handlers (this file) + the six module route descriptors. Order here
// is irrelevant — dispatch is an O(1) Map lookup, never a listener chain.
route({ method: "POST", path: "/extract", handler: handleExtract });
route({ method: "POST", path: "/time-stretch", handler: handleTimeStretch });
route({ method: "POST", path: "/process", handler: handleProcess });
route({ method: "POST", path: "/trim", handler: handleTrim });
route({ method: "POST", path: "/silence-detect", handler: handleSilenceDetect });
route({ method: "POST", path: "/normalize-voice-sample", handler: handleNormalizeVoiceSample });
route({ method: "POST", path: "/concat", handler: handleConcat });
route(routeMixFinal);
route(routeMuxVideo);
route(routeProxyGen);
route(routeHlsIngest);
route(routeHashFile);
route(routeBurnSubtitles);
route(routeMeExtractUpload);
route(routeMeDownloadToS3);

const server = http.createServer(async (req, res) => {
  // /health first — cheapest path, never touches the route table.
  // Now a TRUE readiness probe, not just a liveness ping: `contract_ok`
  // re-runs the boot-time module-contract assertion so the worker can refuse
  // to dispatch to an extractor whose module graph is half-broken (a stale
  // s3-signer.js). Since the boot check exits(1) on a violation, a running
  // process always reports contract_ok:true — but surfacing it keeps the field
  // meaningful for the worker's readiness gate and any future export drift.
  if (req.method === "GET" && req.url === "/health") {
    const contract = checkModuleContract();
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      status: "ok",
      build_tag: BUILD_TAG,
      contract_ok: contract.ok,
      contract_missing: contract.missing,
    }));
  }

  // ONE dispatch, ONE handler per request. A matched handler owns the response
  // exclusively — no chained listener can also write to `res`.
  const matched = routes.get(`${req.method} ${req.url}`);
  if (matched) {
    try {
      return await matched(req, res, API_KEY);
    } catch (err) {
      // Belt-and-suspenders: a handler that threw before writing a response
      // must still terminalise the request instead of hanging the socket.
      console.error(`[router] ${req.method} ${req.url} unhandled:`, err.message);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(3000, () => console.log(`Audio extractor running on port 3000 (build ${BUILD_TAG})`));

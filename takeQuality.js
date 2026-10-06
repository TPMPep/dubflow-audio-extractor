/* eslint-env node */
/* eslint-disable no-undef */
// POST /take-quality — professional per-line QC measurement.
// Every figure is computed from the decoded samples of the exact file supplied
// (source window or rendered preview), never estimated in a browser:
//   loudness (BS.1770 integrated LUFS) + true peak (dBTP, 4x oversampled) via ebur128;
//   clipping runs, DC offset, rumble (<80 Hz), harshness (2-5 kHz), clicks,
//   head/tail dead air and possible vocal fry (pitch-tracked) from PCM in-process.
const { spawn } = require("child_process");
const fs = require("fs");

const SR = 48000;
const PITCH_SR = 8000;

function decodePcm(file, startMs, endMs, timeoutMs = 60000) {
  const args = ["-hide_banner", "-nostdin"];
  if (Number.isFinite(startMs)) args.push("-ss", (startMs / 1000).toFixed(6));
  if (Number.isFinite(startMs) && Number.isFinite(endMs)) args.push("-t", ((endMs - startMs) / 1000).toFixed(6));
  args.push("-i", file, "-vn", "-ac", "1", "-ar", String(SR), "-f", "f32le", "pipe:1");
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "ignore"] });
    const chunks = []; let settled = false;
    const timer = setTimeout(() => { if (settled) return; settled = true; try { child.kill("SIGKILL"); } catch (_) { /* gone */ } reject(new Error("PCM decode timed out")); }, timeoutMs);
    child.stdout.on("data", (d) => chunks.push(d));
    child.on("error", (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
    child.on("close", (code) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (code !== 0) return reject(new Error(`PCM decode exited ${code}`));
      const buf = Buffer.concat(chunks);
      resolve(new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4)));
    });
  });
}

// RBJ biquad, applied in place on a copy.
function biquad(input, type, freq, q, sr) {
  const w = (2 * Math.PI * freq) / sr, cos = Math.cos(w), alpha = Math.sin(w) / (2 * q);
  let b0, b1, b2;
  if (type === "lp") { b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = b0; }
  else if (type === "hp") { b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = b0; }
  else { b0 = alpha; b1 = 0; b2 = -alpha; }
  const a0 = 1 + alpha, a1 = -2 * cos, a2 = 1 - alpha;
  const out = new Float32Array(input.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < input.length; i += 1) {
    const x = input[i];
    const y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    out[i] = y; x2 = x1; x1 = x; y2 = y1; y1 = y;
  }
  return out;
}
const cascade = (x, type, f, sr) => biquad(biquad(x, type, f, 0.5412, sr), type, f, 1.3066, sr); // 4th-order Butterworth
const energy = (x) => { let s = 0; for (let i = 0; i < x.length; i += 1) s += x[i] * x[i]; return s; };
const db = (lin) => (lin > 0 ? 20 * Math.log10(lin) : -Infinity);
const median = (arr) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

// Speech activity per 10 ms frame (RMS above -45 dBFS).
function activity(x) {
  const hop = SR / 100, frames = [];
  for (let i = 0; i + hop <= x.length; i += hop) { let s = 0; for (let j = i; j < i + hop; j += 1) s += x[j] * x[j]; frames.push(db(Math.sqrt(s / hop)) > -45); }
  return frames;
}

// Normalised-autocorrelation pitch track on an 8 kHz copy (40 ms window, 10 ms hop).
// Fry = voiced frames below 70 Hz, or with > 20 % period jump vs the previous
// voiced frame (irregular glottal pulsing), counted only where speech is active.
function fryAnalysis(x) {
  const lp = cascade(x, "lp", 3400, SR);
  const step = SR / PITCH_SR, n = Math.floor(lp.length / step), y = new Float32Array(n);
  for (let i = 0; i < n; i += 1) y[i] = lp[i * step];
  const win = 320, hop = 80, minLag = 20, maxLag = 160; // 400 Hz .. 50 Hz
  let voiced = 0, fry = 0, prev = null;
  for (let start = 0; start + win + maxLag < y.length; start += hop) {
    let e0 = 0; for (let i = start; i < start + win; i += 1) e0 += y[i] * y[i];
    if (db(Math.sqrt(e0 / win)) < -40) { prev = null; continue; }
    let best = 0, bestLag = 0;
    for (let lag = minLag; lag <= maxLag; lag += 1) {
      let c = 0, e1 = 0;
      for (let i = start; i < start + win; i += 1) { c += y[i] * y[i + lag]; e1 += y[i + lag] * y[i + lag]; }
      const r = c / Math.sqrt(e0 * e1 || 1);
      if (r > best) { best = r; bestLag = lag; }
    }
    if (best < 0.45) { prev = null; continue; }
    voiced += 1;
    const f0 = PITCH_SR / bestLag;
    const jump = prev ? Math.abs(bestLag - prev) / prev : 0;
    if (f0 < 70 || jump > 0.2) fry += 1;
    prev = bestLag;
  }
  return { voiced_frames: voiced, fry_pct: voiced ? +(fry / voiced * 100).toFixed(1) : 0 };
}

function measurePcm(x) {
  const total = energy(x) || 1e-12;
  let peak = 0, sum = 0, clipRuns = 0, run = 0;
  for (let i = 0; i < x.length; i += 1) {
    const a = Math.abs(x[i]); sum += x[i];
    if (a > peak) peak = a;
    if (a >= 0.999) { run += 1; if (run === 3) clipRuns += 1; } else run = 0;
  }
  const rumblePct = (energy(cascade(x, "lp", 80, SR)) / total) * 100;
  const harshPct = (energy(biquad(biquad(x, "bp", 3200, 0.9, SR), "bp", 3200, 0.9, SR)) / total) * 100;
  // Clicks: 5 ms frames of a 4 kHz high-pass, peak > 18 dB over the line's own median.
  const hf = cascade(x, "hp", 4000, SR), cf = SR / 200, peaks = [];
  for (let i = 0; i + cf <= hf.length; i += cf) { let p = 0; for (let j = i; j < i + cf; j += 1) p = Math.max(p, Math.abs(hf[j])); peaks.push(db(p)); }
  const finite = peaks.filter(Number.isFinite), med = median(finite);
  const clicks = finite.filter((p) => p > med + 18 && p > -45).length;
  const act = activity(x);
  const first = act.indexOf(true), last = act.lastIndexOf(true);
  const durationMs = Math.round((x.length / SR) * 1000);
  return {
    duration_ms: durationMs,
    sample_peak_dbfs: +db(peak).toFixed(2),
    clipped_runs: clipRuns,
    dc_offset_pct: +((Math.abs(sum / (x.length || 1))) * 100).toFixed(3),
    rumble_pct: +rumblePct.toFixed(2),
    harshness_pct: +harshPct.toFixed(1),
    click_count: clicks,
    leading_silence_ms: first < 0 ? durationMs : first * 10,
    trailing_silence_ms: last < 0 ? durationMs : Math.max(0, durationMs - (last + 1) * 10),
    ...fryAnalysis(x),
  };
}

module.exports = async function takeQuality(req, res, API_KEY, { runFfmpeg }) {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  const token = (req.headers["authorization"] || "").replace("Bearer ", "");
  if (token !== API_KEY && body.api_key !== API_KEY) { res.writeHead(401); return res.end(JSON.stringify({ error: "Unauthorized" })); }
  if (!body.audio_url && !body.audio_base64) { res.writeHead(400); return res.end(JSON.stringify({ error: "audio_url or audio_base64 required" })); }
  const startMs = body.start_ms != null ? Number(body.start_ms) : undefined;
  const endMs = body.end_ms != null ? Number(body.end_ms) : undefined;
  if (startMs != null && (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs - startMs < 50 || endMs - startMs > 120000)) {
    res.writeHead(400); return res.end(JSON.stringify({ error: "start_ms/end_ms must define a 50 ms - 120 s window" }));
  }
  const tmpDir = fs.mkdtempSync("/tmp/take_quality_"); const file = `${tmpDir}/input`;
  try {
    if (body.audio_base64) fs.writeFileSync(file, Buffer.from(body.audio_base64, "base64"));
    else { const src = await fetch(body.audio_url); if (!src.ok) throw new Error(`Download failed: ${src.status}`); fs.writeFileSync(file, Buffer.from(await src.arrayBuffer())); }
    const pcm = await decodePcm(file, startMs, endMs);
    if (pcm.length < SR / 20) throw new Error("Audio window is too short to measure");
    const seek = startMs != null ? ["-ss", (startMs / 1000).toFixed(6), "-t", ((endMs - startMs) / 1000).toFixed(6)] : [];
    const loud = await runFfmpeg(["-hide_banner", "-nostdin", ...seek, "-i", file, "-af", "ebur128=peak=true", "-f", "null", "-"], { timeoutMs: 30000, label: "Quality loudness" });
    const last = (re) => { const m = [...String(loud).matchAll(re)]; return m.length ? Number(m[m.length - 1][1]) : null; };
    const result = {
      ...measurePcm(pcm),
      integrated_lufs: last(/\bI:\s*(-?[\d.]+)\s*LUFS/g),
      true_peak_dbtp: last(/\bPeak:\s*(-?[\d.]+)\s*dBFS/g),
      analyzer: "take-quality-v1:ebur128+pcm", sample_rate_hz: SR,
    };
    fs.rmSync(tmpDir, { recursive: true, force: true });
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(result));
  } catch (err) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* noop */ }
    res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: err.message }));
  }
};

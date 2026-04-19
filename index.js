const http = require("http");
const { execSync } = require("child_process");
const fs = require("fs");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const s3 = new S3Client({
  region: process.env.AWS_REGION || "us-west-2",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.S3_BUCKET || "pep-test";
const API_KEY = process.env.API_KEY || "change-me";

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200);
    return res.end("ok");
  }

  // ── Extract speaker audio segments ──
  if (req.method === "POST" && req.url === "/extract") {
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

      const getCmd = new GetObjectCommand({ Bucket: BUCKET, Key: s3_key });
      const signedUrl = await getSignedUrl(s3, getCmd, { expiresIn: 3600 });

      const tmpDir = `/tmp/${Date.now()}`;
      fs.mkdirSync(tmpDir, { recursive: true });

      const segFiles = [];
      for (let i = 0; i < timestamps.length; i++) {
        const { start_ms, end_ms } = timestamps[i];
        const startSec = (start_ms / 1000).toFixed(3);
        const duration = ((end_ms - start_ms) / 1000).toFixed(3);
        const segFile = `${tmpDir}/seg_${i}.wav`;

        execSync(
          `ffmpeg -ss ${startSec} -t ${duration} -i "${signedUrl}" -vn -acodec pcm_s16le -ar 44100 -ac 1 "${segFile}" -y 2>/dev/null`,
          { timeout: 120000 }
        );
        segFiles.push(segFile);
      }

      const listFile = `${tmpDir}/list.txt`;
      fs.writeFileSync(listFile, segFiles.map(f => `file '${f}'`).join("\n"));

      const outputFile = `${tmpDir}/output.wav`;
      execSync(
        `ffmpeg -f concat -safe 0 -i "${listFile}" -acodec pcm_s16le -ar 44100 -ac 1 "${outputFile}" -y 2>/dev/null`,
        { timeout: 60000 }
      );

      const audioBuffer = fs.readFileSync(outputFile);
      const sizeMB = (audioBuffer.length / 1024 / 1024).toFixed(1);
      console.log(`Extracted ${sizeMB}MB audio (${segFiles.length} segments)`);

      const outputKey = `dubflow/voice-clones/${speaker_label || "speaker"}_${Date.now()}.wav`;
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: outputKey,
        Body: audioBuffer,
        ContentType: "audio/wav",
      }));

      const audioGetCmd = new GetObjectCommand({ Bucket: BUCKET, Key: outputKey });
      const audioSignedUrl = await getSignedUrl(s3, audioGetCmd, { expiresIn: 3600 });

      fs.rmSync(tmpDir, { recursive: true, force: true });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        s3_key: outputKey,
        signed_url: audioSignedUrl,
        size_mb: parseFloat(sizeMB),
        segment_count: segFiles.length,
      }));

    } catch (err) {
      console.error("Extraction error:", err.message);
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── Time-stretch audio to fit a target duration ──
  if (req.method === "POST" && req.url === "/time-stretch") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());

    const authHeader = req.headers["authorization"] || "";
    const token = authHeader.replace("Bearer ", "");
    if (token !== API_KEY && body.api_key !== API_KEY) {
      res.writeHead(401);
      return res.end(JSON.stringify({ error: "Unauthorized" }));
    }

    const { audio_url, target_duration_sec } = body;
    if (!audio_url || !target_duration_sec) {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: "audio_url and target_duration_sec required" }));
    }

    const tmpDir = `/tmp/stretch_${Date.now()}`;
    fs.mkdirSync(tmpDir, { recursive: true });
    const inputFile = `${tmpDir}/input.mp3`;
    const outputFile = `${tmpDir}/output.mp3`;

    try {
      console.log(`Time-stretching audio to ${target_duration_sec}s`);

      const downloadRes = await fetch(audio_url);
      if (!downloadRes.ok) throw new Error(`Download failed: ${downloadRes.status}`);
      const audioArrayBuffer = await downloadRes.arrayBuffer();
      fs.writeFileSync(inputFile, Buffer.from(audioArrayBuffer));

      const probeResult = execSync(
        `ffprobe -v quiet -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${inputFile}"`,
        { timeout: 10000 }
      ).toString().trim();

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
      const filterStr = filters.join(",");

      console.log(`FFmpeg filter: ${filterStr}`);

      execSync(
        `ffmpeg -y -i "${inputFile}" -filter:a "${filterStr}" -vn "${outputFile}" 2>/dev/null`,
        { timeout: 30000 }
      );

      const stretchedBuffer = fs.readFileSync(outputFile);
      console.log(`Stretched audio: ${(stretchedBuffer.length / 1024).toFixed(0)}KB`);

      fs.rmSync(tmpDir, { recursive: true, force: true });

      res.writeHead(200, { "Content-Type": "audio/mpeg" });
      res.end(stretchedBuffer);

    } catch (err) {
      console.error("Time-stretch error:", err.message);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── Process audio with custom FFmpeg filters (supports extra_args for seeking) ──
  if (req.method === "POST" && req.url === "/process") {
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

      // Build FFmpeg command
      const cmd = `ffmpeg -y ${inputFlagsStr}-i "${inputFile}" -af "${filters}"${outputFlagsStr} -c:a libmp3lame -q:a 2 "${outputFile}" 2>/dev/null`;
      console.log(`[process] Running: ${cmd}`);
      execSync(cmd, { timeout: 120000 });

      const outputBuffer = fs.readFileSync(outputFile);
      console.log(`[process] Output: ${(outputBuffer.length / 1024).toFixed(0)}KB`);

      fs.rmSync(tmpDir, { recursive: true, force: true });
      res.writeHead(200, { "Content-Type": `audio/${output_format}` });
      res.end(outputBuffer);
    } catch (err) {
      console.error("[process] Error:", err.message);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }
 // ── Trim audio to a precise window with optional fades ──
  // POST /trim { audio_url, start_ms, end_ms, fade_in_ms?, fade_out_ms?, output_format? }
  // Returns the trimmed audio file binary directly (Content-Type: audio/<format>).
  // Used by pickup-line recording flow to remove dead air based on AssemblyAI word timings
  // OR based on user-dragged trim handles in the preview sandbox.
  if (req.method === "POST" && req.url === "/trim") {
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
      const filterArg = filters.length > 0 ? `-af "${filters.join(",")}"` : "";

      const cmd = `ffmpeg -y -ss ${startSec} -t ${durationSec} -i "${inputFile}" ${filterArg} -c:a libmp3lame -q:a 2 -ac 1 -ar 44100 "${outputFile}" 2>/dev/null`;
      console.log(`[trim] Running: ${cmd}`);
      execSync(cmd, { timeout: 30000 });

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
    return;
  }

  // ── Auto-detect dead air (silence) at the head and tail of an audio clip ──
  // POST /silence-detect { audio_url, silence_threshold_db?, min_silence_duration_sec? }
  // Returns: { duration_sec, leading_silence_sec, trailing_silence_sec,
  //            speech_start_sec, speech_end_sec, silences: [...] }
  // Used by the pickup-line preview sandbox to suggest a smart auto-trim window
  // when AssemblyAI word timings aren't precise enough (or as a sanity check on them).
  if (req.method === "POST" && req.url === "/silence-detect") {
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

      // Get total duration
      const probeOut = execSync(
        `ffprobe -v quiet -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${inputFile}"`,
        { timeout: 10000 }
      ).toString().trim();
      const durationSec = parseFloat(probeOut);
      if (!durationSec || durationSec <= 0) throw new Error("Could not determine audio duration");

      // Run silencedetect — output goes to stderr, not stdout
      let stderr = "";
      try {
        execSync(
          `ffmpeg -i "${inputFile}" -af "silencedetect=noise=${silence_threshold_db}dB:d=${min_silence_duration_sec}" -f null - 2>&1`,
          { timeout: 30000, encoding: "utf8" }
        );
      } catch (e) {
        // ffmpeg writes to stderr; execSync throws when stdout is empty even on success
        stderr = (e.stdout || "") + (e.stderr || "") + (e.message || "");
      }

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
    return;
  }
  // ── Normalize a voice sample for ElevenLabs cloning ──
  // Downloads source from a signed URL, runs denoise + loudness normalization,
  // uploads the result as 44.1kHz mono 16-bit WAV back to S3.
  if (req.method === "POST" && req.url === "/normalize-voice-sample") {
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
      execSync(
        `ffmpeg -y -i "${inputFile}" -af "${ffmpeg_filter}" -ac 1 -ar 44100 -sample_fmt s16 -c:a pcm_s16le "${outputFile}" 2>/dev/null`,
        { timeout: 120000 }
      );

      // Probe duration
      const probeResult = execSync(
        `ffprobe -v quiet -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${outputFile}"`,
        { timeout: 10000 }
      ).toString().trim();
      const durationSec = parseFloat(probeResult) || 0;

      const outputBuffer = fs.readFileSync(outputFile);
      console.log(`[normalize] Output: ${(outputBuffer.length / 1024).toFixed(0)}KB, ${durationSec.toFixed(2)}s`);

      // Upload to the caller's bucket using THEIR credentials (so writes stay
      // within Base44's AWS account, not this service's).
      const callerS3 = new S3Client({
        region: aws_region || process.env.AWS_REGION || "us-west-2",
        credentials: {
          accessKeyId: aws_access_key_id,
          secretAccessKey: aws_secret_access_key,
        },
      });

      await callerS3.send(new PutObjectCommand({
        Bucket: target_bucket,
        Key: target_key,
        Body: outputBuffer,
        ContentType: "audio/wav",
      }));

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
    return;
  }
  // ── Concatenate multiple audio files ──
  if (req.method === "POST" && req.url === "/concat") {
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
      execSync(
        `ffmpeg -f concat -safe 0 -i "${listFile}" -c:a libmp3lame -q:a 2 "${outputFile}" -y 2>/dev/null`,
        { timeout: 120000 }
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
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(3000, () => console.log("Audio extractor running on port 3000"));

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

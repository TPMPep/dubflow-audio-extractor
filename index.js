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

  // ── EXISTING: Extract speaker audio segments ──
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

  // ── NEW: Time-stretch audio to fit a target duration ──
  if (req.method === "POST" && req.url === "/time-stretch") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());

    // Auth via Bearer token or api_key field
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

      // Download the source audio using fetch (works in Node 18+)
      const downloadRes = await fetch(audio_url);
      if (!downloadRes.ok) throw new Error(`Download failed: ${downloadRes.status}`);
      const audioArrayBuffer = await downloadRes.arrayBuffer();
      fs.writeFileSync(inputFile, Buffer.from(audioArrayBuffer));

      // Get original duration using ffprobe
      const probeResult = execSync(
        `ffprobe -v quiet -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${inputFile}"`,
        { timeout: 10000 }
      ).toString().trim();

      const originalDuration = parseFloat(probeResult);
      if (!originalDuration || originalDuration <= 0) {
        throw new Error("Could not determine audio duration");
      }

      // Calculate tempo ratio
      const ratio = originalDuration / target_duration_sec;
      console.log(`Original: ${originalDuration.toFixed(2)}s, Target: ${target_duration_sec}s, Ratio: ${ratio.toFixed(3)}`);

      // Build atempo filter chain (each filter must be between 0.5 and 2.0)
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

      // Run FFmpeg time-stretch (preserves pitch)
      execSync(
        `ffmpeg -y -i "${inputFile}" -filter:a "${filterStr}" -vn "${outputFile}" 2>/dev/null`,
        { timeout: 30000 }
      );

      // Read the result and send it back
      const stretchedBuffer = fs.readFileSync(outputFile);
      console.log(`Stretched audio: ${(stretchedBuffer.length / 1024).toFixed(0)}KB`);

      // Cleanup
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

  res.writeHead(404);
  res.end("Not found");
});

server.listen(3000, () => console.log("Audio extractor running on port 3000"));

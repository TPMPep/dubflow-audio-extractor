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

  if (req.method !== "POST" || req.url !== "/extract") {
    res.writeHead(404);
    return res.end("Not found");
  }

  // Read body
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());

  // Verify API key
  if (body.api_key !== API_KEY) {
    res.writeHead(401);
    return res.end(JSON.stringify({ error: "Unauthorized" }));
  }

  const { s3_key, timestamps, speaker_label } = body;
  // timestamps = [{ start_ms: 1000, end_ms: 5000 }, ...]

  if (!s3_key || !timestamps || timestamps.length === 0) {
    res.writeHead(400);
    return res.end(JSON.stringify({ error: "s3_key and timestamps required" }));
  }

  try {
    console.log(`Extracting audio for ${speaker_label || "speaker"} from ${s3_key}, ${timestamps.length} segments`);

    // Step 1: Generate a signed URL for the source video
    const getCmd = new GetObjectCommand({ Bucket: BUCKET, Key: s3_key });
    const signedUrl = await getSignedUrl(s3, getCmd, { expiresIn: 3600 });

    // Step 2: Build FFmpeg filter to extract specific timestamps
    const tmpDir = `/tmp/${Date.now()}`;
    fs.mkdirSync(tmpDir, { recursive: true });

    // Extract each segment, then concatenate
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

    // Concatenate all segments
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

    // Step 3: Upload to S3
    const outputKey = `dubflow/voice-clones/${speaker_label || "speaker"}_${Date.now()}.wav`;
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: outputKey,
      Body: audioBuffer,
      ContentType: "audio/wav",
    }));

    // Generate signed URL for the uploaded audio
    const audioGetCmd = new GetObjectCommand({ Bucket: BUCKET, Key: outputKey });
    const audioSignedUrl = await getSignedUrl(s3, audioGetCmd, { expiresIn: 3600 });

    // Cleanup
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
});

server.listen(3000, () => console.log("Audio extractor running on port 3000"));

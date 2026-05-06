// proxyGenerator.js — Background proxy generation for the editor.
//
// Pattern matches mixFinal.js: exports a `registerProxyGen(server, API_KEY)`
// that mounts a POST /generate-proxy route on the existing http server.
// Returns 202 immediately, runs ffmpeg in the background, then PATCHes the
// Project entity in Base44 when done (or on failure).

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const axios = require("axios");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const BASE44_API_URL = process.env.BASE44_API_BASE || process.env.BASE44_API_URL || "https://app.base44.com/api";
const BASE44_APP_ID = process.env.BASE44_APP_ID;
const BASE44_SERVICE_TOKEN = process.env.BASE44_SERVICE_TOKEN;

function s3ClientForRegion(region, prefix) {
  const accessKeyId = (prefix && process.env[`${prefix}_ACCESS_KEY_ID`]) || process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = (prefix && process.env[`${prefix}_SECRET_ACCESS_KEY`]) || process.env.AWS_SECRET_ACCESS_KEY;
  return new S3Client({ region, credentials: { accessKeyId, secretAccessKey } });
}

async function patchProject(projectId, patch) {
  if (!BASE44_APP_ID || !BASE44_SERVICE_TOKEN) {
    console.error("[generate-proxy] Missing BASE44_APP_ID or BASE44_SERVICE_TOKEN env var");
    return;
  }
  await axios.patch(
    `${BASE44_API_URL}/apps/${BASE44_APP_ID}/entities/Project/${projectId}`,
    patch,
    { headers: { "api_key": BASE44_SERVICE_TOKEN, "Content-Type": "application/json" } }
  );
}

async function runProxyJob({
  project_id, source_url, bucket, region,
  proxy_video_key, proxy_audio_key, credential_secret_prefix,
}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `proxy-${project_id}-`));
  const videoPath = path.join(tmpDir, "proxy.mp4");
  const audioPath = path.join(tmpDir, "proxy.flac");

  try {
    console.log(`[generate-proxy] ${project_id} starting`);

    // Single ffmpeg pass producing both proxies — only decodes source once.
    const cmd =
      `ffmpeg -hide_banner -loglevel error -i "${source_url}" ` +
      // Video proxy: 720p H.264 ~2 Mbps, AAC 128k stereo
      `-map "0:v:0?" -map "0:a:0?" ` +
      `-c:v libx264 -preset fast -b:v 2M -maxrate 2.5M -bufsize 4M ` +
      `-vf "scale=-2:720" ` +
      `-c:a aac -b:a 128k -ac 2 -movflags +faststart ` +
      `-f mp4 "${videoPath}" ` +
      // Audio proxy: 16 kHz mono FLAC for AssemblyAI / Replicate
      `-map "0:a:0?" -vn -ac 1 -ar 16000 -c:a flac -f flac "${audioPath}"`;

    execSync(cmd, { timeout: 4 * 60 * 60 * 1000, stdio: "inherit" }); // 4hr ceiling

    const s3 = s3ClientForRegion(region, credential_secret_prefix);
    const videoBuffer = fs.readFileSync(videoPath);
    const audioBuffer = fs.readFileSync(audioPath);

    await Promise.all([
      s3.send(new PutObjectCommand({
        Bucket: bucket, Key: proxy_video_key, Body: videoBuffer, ContentType: "video/mp4",
      })),
      s3.send(new PutObjectCommand({
        Bucket: bucket, Key: proxy_audio_key, Body: audioBuffer, ContentType: "audio/flac",
      })),
    ]);

    const proxyMediaUrl = `https://${bucket}.s3.${region}.amazonaws.com/${proxy_video_key}`;
    await patchProject(project_id, {
      proxy_status: "ready",
      proxy_media_key: proxy_video_key,
      proxy_audio_key: proxy_audio_key,
      proxy_media_url: proxyMediaUrl,
      proxy_generated_at: new Date().toISOString(),
      proxy_error: null,
    });
    console.log(`[generate-proxy] ${project_id} ready (video ${(videoBuffer.length / 1024 / 1024).toFixed(0)}MB, audio ${(audioBuffer.length / 1024 / 1024).toFixed(0)}MB)`);
  } catch (err) {
    console.error(`[generate-proxy] ${project_id} failed:`, err.message);
    try {
      await patchProject(project_id, {
        proxy_status: "failed",
        proxy_error: String(err.message || err).slice(0, 500),
      });
    } catch (patchErr) {
      console.error(`[generate-proxy] patch-back failed:`, patchErr.message);
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

function registerProxyGen(server, API_KEY) {
  // Wrap existing request handler: if URL matches our route, handle it; otherwise pass through.
  const previousListener = server.listeners("request")[0];
  server.removeAllListeners("request");

  server.on("request", async (req, res) => {
    if (req.method === "POST" && req.url === "/generate-proxy") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString()); }
      catch { res.writeHead(400); return res.end(JSON.stringify({ error: "bad JSON" })); }

      const authHeader = req.headers["authorization"] || "";
      const token = authHeader.replace("Bearer ", "");
      if (token !== API_KEY && body.api_key !== API_KEY) {
        res.writeHead(401);
        return res.end(JSON.stringify({ error: "Unauthorized" }));
      }

      const required = ["project_id", "source_url", "bucket", "region", "proxy_video_key", "proxy_audio_key"];
      for (const k of required) {
        if (!body[k]) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: `${k} required` }));
        }
      }

      // Fire-and-forget: respond 202 immediately, run job in background.
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ accepted: true, project_id: body.project_id }));

      runProxyJob(body).catch((err) => {
        console.error("[generate-proxy] uncaught:", err);
      });
      return;
    }

    // Not our route — delegate to the original handler.
    if (previousListener) previousListener(req, res);
  });
}

module.exports = { registerProxyGen };

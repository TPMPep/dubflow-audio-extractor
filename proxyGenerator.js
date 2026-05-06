// proxyGenerator.js — Background proxy generation worker for Railway.
//
// Receives a generate-proxy job, immediately returns 202, then runs ffmpeg
// in the background. On completion (or failure) PATCHes the Project entity
// in Base44 directly via the Base44 REST API.
//
// Two outputs per source file:
//   - Video proxy: 720p H.264, 2 Mbps  (~900 MB/hr)
//   - Audio proxy: 16 kHz mono FLAC    (~60 MB/hr — used by AssemblyAI/Replicate)

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const axios = require('axios');

const BASE44_API_URL = process.env.BASE44_API_URL || 'https://app.base44.com/api';
const BASE44_APP_ID = process.env.BASE44_APP_ID;
const BASE44_SERVICE_TOKEN = process.env.BASE44_SERVICE_TOKEN; // service role token

function s3ClientForRegion(region, prefix) {
  // Allow per-profile credential prefixes (matches Base44 _resolveCredentials).
  const accessKeyId = (prefix && process.env[`${prefix}_ACCESS_KEY_ID`]) || process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = (prefix && process.env[`${prefix}_SECRET_ACCESS_KEY`]) || process.env.AWS_SECRET_ACCESS_KEY;
  return new S3Client({ region, credentials: { accessKeyId, secretAccessKey } });
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-2000)}`));
    });
    proc.on('error', reject);
  });
}

async function patchProject(projectId, patch) {
  await axios.patch(
    `${BASE44_API_URL}/apps/${BASE44_APP_ID}/entities/Project/${projectId}`,
    patch,
    { headers: { 'api_key': BASE44_SERVICE_TOKEN, 'Content-Type': 'application/json' } }
  );
}

async function uploadToS3(s3, bucket, key, filePath, contentType) {
  const stream = fs.createReadStream(filePath);
  await s3.send(new PutObjectCommand({
    Bucket: bucket, Key: key, Body: stream, ContentType: contentType,
  }));
}

async function generateProxyJob({
  project_id, source_url, bucket, region,
  proxy_video_key, proxy_audio_key, credential_secret_prefix,
}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `proxy-${project_id}-`));
  const videoPath = path.join(tmpDir, 'proxy.mp4');
  const audioPath = path.join(tmpDir, 'proxy.flac');

  try {
    // Run ffmpeg ONCE producing both outputs in parallel — single decode of source.
    await runFfmpeg([
      '-hide_banner', '-loglevel', 'error',
      '-i', source_url,
      // Video proxy: 720p H.264, ~2 Mbps, fast preset, AAC 128k stereo audio
      '-map', '0:v:0?', '-map', '0:a:0?',
      '-c:v', 'libx264', '-preset', 'fast', '-b:v', '2M', '-maxrate', '2.5M', '-bufsize', '4M',
      '-vf', 'scale=-2:720',
      '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
      '-movflags', '+faststart',
      '-f', 'mp4', videoPath,
      // Audio proxy: 16 kHz mono FLAC for AssemblyAI / Replicate
      '-map', '0:a:0?',
      '-vn', '-ac', '1', '-ar', '16000',
      '-c:a', 'flac',
      '-f', 'flac', audioPath,
    ]);

    const s3 = s3ClientForRegion(region, credential_secret_prefix);
    await Promise.all([
      uploadToS3(s3, bucket, proxy_video_key, videoPath, 'video/mp4'),
      uploadToS3(s3, bucket, proxy_audio_key, audioPath, 'audio/flac'),
    ]);

    // We don't sign here — Base44's signProjectAssets / editor will sign on demand.
    // Just store the S3 keys and a public URL pattern; the SDK refreshes signed URLs.
    const proxyMediaUrl = `https://${bucket}.s3.${region}.amazonaws.com/${proxy_video_key}`;

    await patchProject(project_id, {
      proxy_status: 'ready',
      proxy_media_key: proxy_video_key,
      proxy_audio_key: proxy_audio_key,
      proxy_media_url: proxyMediaUrl,
      proxy_generated_at: new Date().toISOString(),
      proxy_error: null,
    });
    console.log(`[generateProxy] ${project_id} ready`);
  } catch (err) {
    console.error(`[generateProxy] ${project_id} failed:`, err.message);
    await patchProject(project_id, {
      proxy_status: 'failed',
      proxy_error: String(err.message || err).slice(0, 500),
    }).catch((e) => console.error('PATCH failed too:', e.message));
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { generateProxyJob };
3. Add the route to index.js (in your Railway repo):
const { generateProxyJob } = require('./proxyGenerator');

// ... inside your existing express app, alongside /process:

app.post('/generate-proxy', authMiddleware, (req, res) => {
  const body = req.body || {};
  const required = ['project_id', 'source_url', 'bucket', 'region', 'proxy_video_key', 'proxy_audio_key'];
  for (const k of required) {
    if (!body[k]) return res.status(400).json({ error: `${k} required` });
  }
  // Fire-and-forget: respond 202 immediately, run job in background.
  res.status(202).json({ accepted: true, project_id: body.project_id });
  generateProxyJob(body).catch((err) => {
    console.error('[generateProxy] uncaught:', err);
  });
});

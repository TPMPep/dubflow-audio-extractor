/* eslint-env node */
/* eslint-disable no-undef */
// =============================================================================
// hashFile.js — POST /hash-file — streaming SHA-256 of an S3 object.
// -----------------------------------------------------------------------------
// WHY THIS EXISTS (reliability, not memory):
//   The malware gate (base44/functions/scanUploadedFile) needs the SHA-256 of
//   the source media for the OPSWAT reputation lookup + the tamper-evidence
//   media_sha256 audit invariant. It used to stream-hash the file INSIDE the
//   Deno function, but that read is throughput-bound at ~54.6 ms/MB, so the
//   function's total wall-clock scales linearly with file size. Measured
//   production evidence: clean 1,408 MB scans ran 74–78 s (right at the Deno
//   execution ceiling); a 1,556 MB file projects to ~81 s of hash time and the
//   isolate was KILLED mid-stream before it could write a terminal verdict (no
//   MalwareScanResult, null media_sha256, zero logs — the wall-clock-kill
//   signature). It was a TIME threshold (~78–90 s of function time), not a
//   memory cliff — smaller files always finished; files past the ceiling died
//   non-deterministically.
//
//   This Railway service has NO short execution ceiling and reads S3 at
//   ffmpeg-grade throughput, so an 80 s (or 300 s) hash is a non-event here.
//   scanUploadedFile calls THIS route for the digest and stays the sole malware
//   orchestrator + audit owner (OPSWAT calls + verdict + MalwareScanResult all
//   remain in the Deno function). The ONLY thing moved off the function is the
//   heavyweight streaming read. SOC 2 CC7.2 — the malware gate now reaches a
//   terminal state deterministically at any file size.
//
// MEMORY: Node's crypto.createHash consumes the S3 GET stream chunk-by-chunk
//   and retains only the ~256-byte hash state — never materialises the file.
//   Bit-identical to crypto.subtle.digest / any FIPS 180-4 SHA-256, so the
//   auditor integrity invariant (media_sha256) is preserved exactly.
//
// CONTRACT:
//   POST /hash-file
//   Auth: Authorization: Bearer <API_KEY>  OR  body.api_key === API_KEY
//   Body (multi-region aware — caller forwards the project's storage creds so
//   the hash reads from the SAME bucket/region the object physically lives in):
//     {
//       s3_key: string,                 // REQUIRED — object to hash
//       bucket: string,                 // REQUIRED — project's storage bucket
//       region: string,                 // REQUIRED — project's storage region
//       aws_access_key_id: string,      // REQUIRED — project profile creds
//       aws_secret_access_key: string,  // REQUIRED
//       aws_session_token?: string,     // optional (STS temporary creds)
//       endpoint?: string,              // optional (S3-compatible endpoint)
//       api_key?: string,               // optional (alternative to Bearer)
//     }
//   200 → { ok: true, sha256: string(lowercase hex), bytes: number,
//           duration_ms: number }
//   4xx/5xx → { error: string }
// =============================================================================

const crypto = require("crypto");
const { presignS3Url, storageFromExplicit } = require("./s3-signer");

async function handleHashFile(req, res, API_KEY) {
  const t0 = Date.now();
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Invalid JSON body" }));
  }

  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.replace("Bearer ", "");
  if (token !== API_KEY && body.api_key !== API_KEY) {
    res.writeHead(401, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Unauthorized" }));
  }

  const {
    s3_key,
    bucket,
    region,
    aws_access_key_id,
    aws_secret_access_key,
    aws_session_token,
    endpoint,
  } = body;

  if (!s3_key || !bucket || !region || !aws_access_key_id || !aws_secret_access_key) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        error: "s3_key, bucket, region, aws_access_key_id, aws_secret_access_key required",
      }),
    );
  }

  try {
    const storage = storageFromExplicit({
      region,
      bucket,
      accessKeyId: aws_access_key_id,
      secretAccessKey: aws_secret_access_key,
      sessionToken: aws_session_token,
      endpoint: endpoint || null,
    });

    // Presigned GET + native fetch → a WHATWG ReadableStream we consume
    // chunk-by-chunk. Long expiry so a multi-GB stream never expires mid-read.
    const url = await presignS3Url({ method: "GET", storage, key: s3_key, expiresIn: 3600 });
    const getRes = await fetch(url);
    if (!getRes.ok || !getRes.body) {
      res.writeHead(502, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: `S3 GET ${s3_key} -> HTTP ${getRes.status}` }));
    }

    // Streaming SHA-256 — memory-bounded (one chunk + ~256B state), no
    // execution ceiling on Railway. Bit-identical to any FIPS 180-4 digest.
    const hash = crypto.createHash("sha256");
    let bytes = 0;
    const reader = getRes.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        hash.update(value);
        bytes += value.byteLength;
      }
    }
    const sha256 = hash.digest("hex");

    console.log(
      `[hash-file] ${s3_key} → ${sha256} (${(bytes / 1048576).toFixed(1)}MB, ${((Date.now() - t0) / 1000).toFixed(1)}s)`,
    );

    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, sha256, bytes, duration_ms: Date.now() - t0 }));
  } catch (err) {
    console.error("[hash-file] Error:", err.message);
    res.writeHead(500, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: err.message }));
  }
}

function registerHashFile(server, API_KEY) {
  // Wrap existing request handler — same convention as proxyGenerator / hlsIngest.
  const previousListener = server.listeners("request")[0];
  server.removeAllListeners("request");

  server.on("request", async (req, res) => {
    if (req.method === "POST" && req.url === "/hash-file") {
      return handleHashFile(req, res, API_KEY);
    }
    if (previousListener) previousListener(req, res);
  });
}

module.exports = { registerHashFile };

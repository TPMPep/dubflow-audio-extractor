/* eslint-env node */
/* eslint-disable no-undef */
// =============================================================================
// s3-signer.js — Zero-dependency WebCrypto SigV4 signer for the audio extractor.
// -----------------------------------------------------------------------------
// SHARED, single-source-of-truth S3 signer for this Node service. Replaces the
// forbidden @aws-sdk/@smithy stack (incident 2026-07-07/08 — non-deterministic
// dependency poisoning in serverless runtimes; the same class of packages
// caused per-replica breakage). Byte-faithful port of base44/functions/
// _lib_storage's canonical WebCrypto SigV4 primitives, adapted to CommonJS +
// Node 20 (global `crypto.subtle`, global `fetch`).
//
// DEFENSIVE STS SESSION-TOKEN SUPPORT (2026-07-10):
//   Long-lived AKIA credentials carry NO session token. Temporary ASIA
//   credentials (STS AssumeRole / instance-profile / OIDC) REQUIRE the session
//   token to be presented alongside the signature or S3 rejects the request
//   with 403 InvalidAccessKeyId / SignatureDoesNotMatch. This signer threads it
//   through BOTH request shapes:
//     • presigned URL  → X-Amz-Security-Token as a SIGNED query parameter
//     • header-signed   → x-amz-security-token as a SIGNED header
//   When no session token is present the behavior is IDENTICAL to before
//   (no token param, no token header) — a pure additive, back-compatible change.
//
// EXPORTS (only what index.js / hlsIngest.js / proxyGenerator.js need):
//   • presignS3Url({ method, storage, key, expiresIn, extraQuery })  → string
//   • putS3Object(storage, key, body, { contentType, timeoutMs })    → { ok }
//   • putS3ObjectStreaming(storage, key, filePath, { contentType })  → { ok }
//       streams a file from disk → S3 with NO in-memory buffering (OOM cure)
//   • createSemaphore(max)  → { tryAcquire, release, inUse, max }
//       shared FAST-503 bounded concurrency gate for heavy routes
//   • storageFromEnv({ region, bucket, prefix })                     → handle
//   • storageFromExplicit({ region, bucket, accessKeyId, secretAccessKey,
//                           sessionToken, endpoint })                → handle
// A "storage handle" is a plain object:
//   { region, bucket, endpoint|null, creds: { accessKeyId, secretAccessKey,
//                                              sessionToken|undefined } }
// =============================================================================

const fs = require("fs");
const _te = new TextEncoder();
function _hex(bytes) { let s = ""; for (const b of bytes) s += b.toString(16).padStart(2, "0"); return s; }
async function _sha256Hex(str) { return _hex(new Uint8Array(await crypto.subtle.digest("SHA-256", _te.encode(str)))); }
async function _hmac(keyBytes, msg) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, _te.encode(msg)));
}
const _sigKeyCache = new Map();
async function _signingKey(secret, dateStamp, region) {
  const ck = `${dateStamp}:${region}`;
  if (_sigKeyCache.has(ck)) return _sigKeyCache.get(ck);
  let k = await _hmac(_te.encode("AWS4" + secret), dateStamp);
  k = await _hmac(k, region); k = await _hmac(k, "s3"); k = await _hmac(k, "aws4_request");
  _sigKeyCache.set(ck, k); return k;
}
function _awsEncode(str) { return encodeURIComponent(str).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()); }
function _awsEncodePath(path) { return path.split("/").map(_awsEncode).join("/"); }
const _EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

// ── Presign a GET (download) or PUT (upload) URL ────────────────────────────
// STS: when storage.creds.sessionToken is present it is added as a SIGNED
// X-Amz-Security-Token query param. When absent, the param is omitted entirely
// (identical to pre-STS behavior).
async function presignS3Url({ method, storage, key, expiresIn = 3600, extraQuery = {} }) {
  const { region, creds: { accessKeyId, secretAccessKey, sessionToken }, endpoint, bucket } = storage;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  let host, canonicalUri;
  if (endpoint) { host = new URL(endpoint).host; canonicalUri = `/${bucket}/${_awsEncodePath(key)}`; }
  else { host = `${bucket}.s3.${region}.amazonaws.com`; canonicalUri = `/${_awsEncodePath(key)}`; }
  const params = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${accessKeyId}/${scope}`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(expiresIn)],
    ["X-Amz-SignedHeaders", "host"],
  ];
  // STS temporary credentials: the security token is a SIGNED query param.
  if (sessionToken) params.push(["X-Amz-Security-Token", sessionToken]);
  for (const [k, v] of Object.entries(extraQuery)) params.push([k, v]);
  params.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const canonicalQuery = params.map(([k, v]) => `${_awsEncode(k)}=${_awsEncode(v)}`).join("&");
  const canonicalRequest = [method, canonicalUri, canonicalQuery, `host:${host}`, "", "host", "UNSIGNED-PAYLOAD"].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await _sha256Hex(canonicalRequest)].join("\n");
  const signature = _hex(await _hmac(await _signingKey(secretAccessKey, dateStamp, region), stringToSign));
  return `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

// ── Write an S3 object body — HEADER-signed PUT + native fetch ──────────────
// A PUT with a real body cannot use the presigned-URL pattern for the body
// hash cleanly across every caller, so we header-sign it. STS: when a session
// token is present it is added as a SIGNED x-amz-security-token header.
async function putS3Object(storage, key, body, { contentType, timeoutMs = 120000 } = {}) {
  const { region, creds: { accessKeyId, secretAccessKey, sessionToken }, endpoint, bucket } = storage;
  // Normalize body to bytes so we can hash the payload deterministically.
  let bytes;
  if (body instanceof Uint8Array) bytes = body;
  else if (typeof body === "string") bytes = _te.encode(body);
  else if (Buffer.isBuffer(body)) bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  else bytes = new Uint8Array(body);
  const payloadHash = _hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  let host, canonicalUri;
  if (endpoint) { host = new URL(endpoint).host; canonicalUri = `/${bucket}/${_awsEncodePath(key)}`; }
  else { host = `${bucket}.s3.${region}.amazonaws.com`; canonicalUri = `/${_awsEncodePath(key)}`; }
  const headers = { host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
  if (contentType) headers["content-type"] = contentType;
  // STS temporary credentials: the security token is a SIGNED header.
  if (sessionToken) headers["x-amz-security-token"] = sessionToken;
  const sortedHeaderKeys = Object.keys(headers).sort();
  const signedHeaders = sortedHeaderKeys.join(";");
  const canonicalHeaders = sortedHeaderKeys.map((h) => `${h}:${headers[h]}\n`).join("");
  const canonicalRequest = ["PUT", canonicalUri, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await _sha256Hex(canonicalRequest)].join("\n");
  const signature = _hex(await _hmac(await _signingKey(secretAccessKey, dateStamp, region), stringToSign));
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://${host}${canonicalUri}`, {
      method: "PUT", headers: { ...headers, authorization }, body: bytes, signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`S3 PUT ${key} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return { ok: true, status: res.status };
  } finally { clearTimeout(t); }
}

// ── STREAMING S3 upload — the OOM cure for large proxy/mix deliverables ──────
// putS3Object() above hashes the WHOLE body in memory and hands the entire
// Buffer to fetch — fine for small audio clips, FATAL for a 540MB ProRes proxy
// (fs.readFileSync loads the whole proxy into RAM, then the SHA-256 digest
// holds a second copy, then fetch buffers a third). Under concurrent heavy
// transcodes that is the exact OOM → SIGKILL → Railway 502 "Application failed
// to respond" death spiral we hit on broadcast masters.
//
// This variant NEVER loads the object into RAM. It streams the file from disk
// directly into the fetch body (Node auto-frames it as a chunked/known-length
// stream), and it uses the SigV4 STREAMING-UNSIGNED-PAYLOAD content marker
// (UNSIGNED-PAYLOAD) so the payload hash is NOT required up front — the whole
// point is to avoid reading the file to hash it. AWS S3 accepts
// UNSIGNED-PAYLOAD over HTTPS (the TLS channel provides integrity); this is the
// same posture our presigned PUTs already use. Content-Length is provided from
// fs.stat so S3 gets an exact byte count with no in-memory buffering.
//
// STS-aware, identical to putS3Object. Peak memory is bounded by the stream
// highWaterMark (~64KB), NOT the file size — a 1GB proxy uploads with the same
// memory footprint as a 1MB clip.
async function putS3ObjectStreaming(storage, key, filePath, { contentType, timeoutMs = 30 * 60 * 1000 } = {}) {
  const { region, creds: { accessKeyId, secretAccessKey, sessionToken }, endpoint, bucket } = storage;
  const stat = fs.statSync(filePath);
  const contentLength = stat.size;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  let host, canonicalUri;
  if (endpoint) { host = new URL(endpoint).host; canonicalUri = `/${bucket}/${_awsEncodePath(key)}`; }
  else { host = `${bucket}.s3.${region}.amazonaws.com`; canonicalUri = `/${_awsEncodePath(key)}`; }
  // UNSIGNED-PAYLOAD: the payload hash is the fixed marker, so we never read the
  // file to compute a SHA-256. TLS guarantees transport integrity.
  const payloadHash = "UNSIGNED-PAYLOAD";
  const headers = { host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
  if (contentType) headers["content-type"] = contentType;
  if (sessionToken) headers["x-amz-security-token"] = sessionToken;
  const sortedHeaderKeys = Object.keys(headers).sort();
  const signedHeaders = sortedHeaderKeys.join(";");
  const canonicalHeaders = sortedHeaderKeys.map((h) => `${h}:${headers[h]}\n`).join("");
  const canonicalRequest = ["PUT", canonicalUri, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await _sha256Hex(canonicalRequest)].join("\n");
  const signature = _hex(await _hmac(await _signingKey(secretAccessKey, dateStamp, region), stringToSign));
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  // Stream the file from disk. `duplex: 'half'` is REQUIRED by the Node/undici
  // fetch when the body is a stream. Content-Length lets S3 pre-allocate and
  // avoids chunked-transfer ambiguity.
  const bodyStream = fs.createReadStream(filePath);
  try {
    const res = await fetch(`https://${host}${canonicalUri}`, {
      method: "PUT",
      headers: { ...headers, authorization, "content-length": String(contentLength) },
      body: bodyStream,
      duplex: "half",
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`S3 streaming PUT ${key} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return { ok: true, status: res.status, bytes: contentLength };
  } finally {
    clearTimeout(t);
    try { bodyStream.destroy(); } catch (_) { /* already closed */ }
  }
}

// ── Bounded concurrency semaphore — SHARED heavy-lane gate primitive ─────────
// Single source of truth for the "cap N heavy transcodes at once" pattern. This
// is deliberately a FAST-503 gate, NOT a long acquire-wait queue: the reverted
// gate (see index.js history) held callers in a FIFO wait for up to 10 min,
// which is ~6× longer than Cloudflare's ~100s edge tolerates a silent
// connection — so a queued export always 524'd before it ran. Here, tryAcquire
// returns false IMMEDIATELY when the lane is full; the caller returns HTTP 503
// and the BullMQ worker owns the wait via its own exponential backoff. No HTTP
// connection is ever held open waiting for a slot, so a 524 is structurally
// impossible. SOC 2 CC7.2 — bounded, observable, never-wedging concurrency.
function createSemaphore(max) {
  let inUse = 0;
  return {
    max,
    inUse: () => inUse,
    tryAcquire() { if (inUse >= max) return false; inUse++; return true; },
    release() { if (inUse > 0) inUse--; },
  };
}

// ── Credential resolution helpers ───────────────────────────────────────────
// Resolve creds from env, honoring an optional profile prefix AND its
// prefix-scoped session token. Long-lived AKIA creds have no *_SESSION_TOKEN,
// so sessionToken resolves undefined and every downstream signer omits it.
function _resolveEnvCreds(prefix) {
  if (prefix) {
    return {
      accessKeyId: process.env[`${prefix}_ACCESS_KEY_ID`] || process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env[`${prefix}_SECRET_ACCESS_KEY`] || process.env.AWS_SECRET_ACCESS_KEY,
      sessionToken: process.env[`${prefix}_SESSION_TOKEN`] || process.env.AWS_SESSION_TOKEN || undefined,
    };
  }
  return {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    sessionToken: process.env.AWS_SESSION_TOKEN || undefined,
  };
}

// Build a storage handle from env (this service's own creds, optionally a
// per-request credential prefix). `region`/`bucket` are the resolved values
// the caller already computed from the request body / env.
function storageFromEnv({ region, bucket, prefix = "", endpoint = null }) {
  return { region, bucket, endpoint, creds: _resolveEnvCreds(prefix) };
}

// Build a storage handle from explicit caller-supplied credentials (the
// /normalize-voice-sample path forwards Base44's creds so writes land in
// Base44's AWS account). Honors an explicit sessionToken when the caller
// forwards temporary STS creds.
function storageFromExplicit({ region, bucket, accessKeyId, secretAccessKey, sessionToken, endpoint = null }) {
  return { region, bucket, endpoint, creds: { accessKeyId, secretAccessKey, sessionToken: sessionToken || undefined } };
}

module.exports = { presignS3Url, putS3Object, putS3ObjectStreaming, createSemaphore, storageFromEnv, storageFromExplicit };

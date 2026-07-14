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
//   • storageFromEnv({ region, bucket, prefix })                     → handle
//   • storageFromExplicit({ region, bucket, accessKeyId, secretAccessKey,
//                           sessionToken, endpoint })                → handle
// A "storage handle" is a plain object:
//   { region, bucket, endpoint|null, creds: { accessKeyId, secretAccessKey,
//                                              sessionToken|undefined } }
// =============================================================================

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

module.exports = { presignS3Url, putS3Object, storageFromEnv, storageFromExplicit };

/* global require: readonly, module: readonly, Buffer: readonly */
const fs = require('fs');
let activeWindows = 0;
module.exports = async function studioWindow(req, res, key, { runFfmpeg, runFfprobe }) {
  let directory;
  let admitted = false;
  try {
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 16384) { res.writeHead(413); return res.end(); } chunks.push(chunk); }
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (body.api_key !== key && req.headers.authorization !== `Bearer ${key}`) { res.writeHead(401); return res.end(); }
    const start = Number(body.start_ms), end = Number(body.end_ms), url = new URL(body.audio_url);
    if (url.protocol !== 'https:' || !url.searchParams.has('X-Amz-Signature') || !Number.isFinite(start) || start < 0 || !Number.isFinite(end) || end <= start || end - start > 90000 || end > 14400000) { res.writeHead(400); return res.end(JSON.stringify({ error: 'A signed source and a 0–90 second programme window are required.' })); }
    if (activeWindows >= 2) { res.writeHead(503, { 'Retry-After': '3' }); return res.end(JSON.stringify({ error: 'Studio extraction is at capacity; retry this queued line.' })); }
    activeWindows++; admitted = true;
    directory = fs.mkdtempSync('/tmp/studio_window_');
    const output = `${directory}/source.wav`;
    // Input seeking uses S3 ranges: never download/buffer a whole programme per line.
    // No gain, fades, padding, pitch changes, or inferred timing on the donor.
    await runFfmpeg(['-y','-nostdin','-rw_timeout','15000000','-ss',(start / 1000).toFixed(6),'-i',body.audio_url,'-t',((end - start) / 1000).toFixed(6),'-vn','-ac','1','-ar','48000','-c:a','pcm_s24le',output], { timeoutMs: 60000, label: 'Studio source window' });
    const measured = await runFfprobe(['-v','quiet','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',output]);
    const duration = Math.round(Number(measured) * 1000), bytes = fs.readFileSync(output);
    if (!duration || Math.abs(duration - (end - start)) > 40 || bytes.length < 1024) throw new Error('Studio donor duration does not match the authored window.');
    res.writeHead(200, { 'Content-Type':'audio/wav', 'X-Output-Duration-Ms':String(duration), 'X-Trim-Start-Ms':String(start), 'X-Trim-End-Ms':String(end) });
    res.end(bytes);
  } catch (error) { res.writeHead(500, { 'Content-Type':'application/json' }); res.end(JSON.stringify({ error: error.message })); }
  finally { if (admitted) activeWindows--; if (directory) fs.rmSync(directory, { recursive:true, force:true }); }
};

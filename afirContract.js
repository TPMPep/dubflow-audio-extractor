/* eslint-disable no-undef */
const { spawn } = require('child_process');
let contractPromise;
function getAfirNormalization() {
  if (!contractPromise) contractPromise = new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-h', 'filter=afir'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let help = '', settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('FFmpeg convolution capability probe timed out')); }, 5000);
    child.stdout.on('data', chunk => { help += chunk; });
    child.stderr.on('data', chunk => { help += chunk; });
    child.on('error', error => finish(error));
    child.on('close', code => {
      if (code !== 0) return finish(new Error('FFmpeg convolution capability probe failed'));
      if (/\birnorm\b/.test(help)) return finish(null, 'irnorm=-1');
      if (/\bgtype\b/.test(help)) return finish(null, 'gtype=none');
      finish(new Error('FFmpeg cannot preserve the authored impulse-response coefficients'));
    });
  }).catch(error => { contractPromise = null; throw error; });
  return contractPromise;
}
module.exports = { getAfirNormalization };

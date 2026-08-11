/* eslint-env node */
/* global require, Buffer, module */
const fs = require('fs');

function recipeKey(recipe = {}) {
  return ['room_mix','early_reflections','pre_delay_ms','decay_seconds','damping','stereo_width']
    .map((key) => Number(recipe[key] || 0).toFixed(4)).join('|');
}

function seedFrom(value) {
  let seed = 2166136261;
  for (let i = 0; i < value.length; i++) { seed ^= value.charCodeAt(i); seed = Math.imul(seed, 16777619); }
  return seed >>> 0;
}

function makeRandom(seed) {
  let state = seed || 1;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
}

function buildImpulse(recipe = {}, sampleRate = 48000) {
  const room = Math.max(0, Math.min(.75, Number(recipe.room_mix) || 0));
  const early = Math.max(0, Math.min(1, Number(recipe.early_reflections ?? .5)));
  const preSec = Math.max(0, Math.min(.12, Number(recipe.pre_delay_ms || 0) / 1000));
  const decaySec = Math.max(.1, Math.min(3.5, Number(recipe.decay_seconds || .35)));
  const damping = Math.max(0, Math.min(1, Number(recipe.damping || 0)));
  const width = Math.max(0, Math.min(1, Number(recipe.stereo_width ?? 1)));
  const frames = Math.ceil((preSec + decaySec + .08) * sampleRate);
  const channels = [new Float32Array(frames), new Float32Array(frames)];
  channels[0][0] = 1; channels[1][0] = 1;
  const earlyTaps = [[.007,.34,-1],[.017,.27,1],[.031,.22,-.55],[.053,.17,.55]];
  for (const [seconds, weight, side] of earlyTaps) {
    const index = Math.min(frames - 1, Math.round((preSec + seconds) * sampleRate));
    const pan = side * width * .65;
    channels[0][index] += room * early * weight * (pan > 0 ? 1 - pan : 1);
    channels[1][index] += room * early * weight * (pan < 0 ? 1 + pan : 1);
  }
  const start = Math.round(preSec * sampleRate);
  const smoothing = .012 + (1 - damping) * .16;
  for (let channel = 0; channel < 2; channel++) {
    const random = makeRandom(seedFrom(`${recipeKey(recipe)}|${channel}`));
    let filtered = 0;
    for (let i = start; i < frames; i++) {
      const time = (i - start) / sampleRate;
      filtered += ((random() * 2 - 1) - filtered) * smoothing;
      const envelope = Math.exp(-6.907755 * time / decaySec);
      channels[channel][i] += filtered * envelope * room * (1 - early) * .22;
    }
  }
  return channels;
}

function writeFloatWav(filePath, channels, sampleRate = 48000) {
  const frames = channels[0].length, channelCount = channels.length, dataBytes = frames * channelCount * 4;
  const out = Buffer.allocUnsafe(44 + dataBytes);
  out.write('RIFF', 0); out.writeUInt32LE(36 + dataBytes, 4); out.write('WAVE', 8); out.write('fmt ', 12);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(3, 20); out.writeUInt16LE(channelCount, 22); out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * channelCount * 4, 28); out.writeUInt16LE(channelCount * 4, 32); out.writeUInt16LE(32, 34);
  out.write('data', 36); out.writeUInt32LE(dataBytes, 40);
  let offset = 44;
  for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < channelCount; channel++) { out.writeFloatLE(channels[channel][frame], offset); offset += 4; }
  fs.writeFileSync(filePath, out);
}

module.exports = { buildImpulse, recipeKey, writeFloatWav };

// Downloads the 3D character model at build time (not stored in git).
// Fails gracefully — the game has a fallback character if the model is missing.
import { existsSync, mkdirSync, createWriteStream } from 'node:fs';
import { get } from 'node:https';
import { dirname } from 'node:path';

const DEST = 'public/models/character.glb';
// Full-quality original model (user-supplied, face preserved sem-to-sem)
// NOTE: small version first for fast mobile loading
const URLS = [
  'https://muse.ai/files/1309069215631594/1462915465938091/oprmaaxn1xwwbed5ts7jv6vz/character_small.glb',
  'https://muse.ai/files/1309069215631594/1083257314469081/jw4dumau7rdl3f3v0o7dpzyp/character.glb',
];

if (existsSync(DEST)) {
  console.log('[fetch-model] already exists, skipping');
  process.exit(0);
}
mkdirSync(dirname(DEST), { recursive: true });

function dl(url) {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return dl(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
      const ws = createWriteStream(DEST);
      res.pipe(ws);
      ws.on('finish', () => resolve());
      ws.on('error', reject);
    }).on('error', reject);
  });
}

let ok = false;
for (const u of URLS) {
  try {
    console.log('[fetch-model] downloading...');
    await dl(u);
    const { statSync } = await import('node:fs');
    const sz = statSync(DEST).size;
    if (sz > 100000) { console.log(`[fetch-model] done (${(sz/1048576).toFixed(1)} MB)`); ok = true; break; }
  } catch (e) { console.log('[fetch-model] failed:', e.message); }
}
if (!ok) console.log('[fetch-model] WARNING: model not downloaded — game will use fallback character');

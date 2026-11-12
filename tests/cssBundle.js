// Reads the app's CSS the way the browser gets it: the ./css/*.css files
// imported by frontend/src/main.jsx, concatenated in import order
// (v0.7.0 split of the old monolithic frontend/src/index.css). The
// import order is the cascade order, so the bundle is exactly what
// Vite ships — tests assert against this, never a single file.
import { readFileSync } from 'node:fs';

export function readCssBundle() {
  const main = readFileSync(new URL('../frontend/src/main.jsx', import.meta.url), 'utf8');
  const files = [...main.matchAll(/import '\.\/css\/([^']+\.css)';/g)].map((m) => m[1]);
  if (files.length === 0) throw new Error('no ./css/*.css imports found in main.jsx');
  return files
    .map((f) => readFileSync(new URL(`../frontend/src/css/${f}`, import.meta.url), 'utf8'))
    .join('');
}

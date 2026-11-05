// Reads aegis/.env (KEY=value lines, # comments) without printing anything. Values already in
// process.env win, so CI can set them directly.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadEnv() {
  const out = {};
  const file = path.join(ROOT, '.env');
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m || line.trim().startsWith('#')) continue;
      out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && v !== '') out[k] = v;
  return out;
}

// Rewrites literal invisible characters (ZWNJ, bidi marks, …) in tgcloud/ as \uXXXX escapes.
// Run after editing texts: `node scripts/fix-invisible.mjs`. The guard test fails if any remain.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../tgcloud');
const RE = /[​-‏‪-‮⁦-⁩﻿­]/g;
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) {
      const s = fs.readFileSync(p, 'utf8');
      const n = (s.match(RE) || []).length;
      if (n) {
        fs.writeFileSync(p, s.replace(RE, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')));
        console.log(`${path.relative(ROOT, p)}: ${n} escaped`);
      }
    }
  }
})(ROOT);

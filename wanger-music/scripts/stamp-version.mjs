// Writes tgcloud/lib/core/version.js (package version, git commit, build time) before a deploy,
// so 🧪 System Status shows what is running.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
let commit = 'unknown';
try {
  commit = execSync('git rev-parse --short HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  const dirty = execSync('git status --porcelain -- tgcloud', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString()
    .split('\n').filter((l) => l.trim() && !l.includes('tgcloud/lib/core/version.js'));
  if (dirty.length) commit += '-dirty';
} catch {
  // not a git checkout
}
const builtAt = Math.floor(Date.now() / 1000);
const file = path.join(ROOT, 'tgcloud/lib/core/version.js');
fs.writeFileSync(file, `// Deployed version — rewritten by scripts/stamp-version.mjs on every \`npm run deploy\` (pure).
export const VERSION = Object.freeze({ version: ${JSON.stringify(pkg.version)}, commit: ${JSON.stringify(commit)}, built_at: ${builtAt} });
`);
console.log(`version.js: ${pkg.version} ${commit} ${new Date(builtAt * 1000).toISOString()}`);

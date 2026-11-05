// The CLI token for THIS bot only. It comes from X_BOT_TGCLOUD_TOKEN (environment, or
// x_downloader_bot/.env, which is git-ignored) and is handed to the tgcloud CLI as TGCLOUD_TOKEN for
// child processes only — never printed, never written to disk. A generic TGCLOUD_TOKEN is ignored on
// purpose: this repository holds several bots, and that one could belong to any of them.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TOKEN_VAR = 'X_BOT_TGCLOUD_TOKEN';

function readDotEnv() {
  const out = {};
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

/** The environment for a tgcloud CLI child process, or { error } when the token is missing or malformed. */
export function cliEnv() {
  const token = process.env[TOKEN_VAR] || readDotEnv()[TOKEN_VAR];
  if (!token) return { error: `${TOKEN_VAR} is not set (environment or x_downloader_bot/.env). See .env.example.` };
  if (!/^app\d+:\S+$/.test(token)) {
    return { error: `${TOKEN_VAR} doesn't look like a CLI access token (app<id>:<secret>). The bot token is not it: BotFather → your bot → Serverless → CLI Access.` };
  }
  const env = { ...process.env, TGCLOUD_TOKEN: token };
  // Behind an HTTPS proxy, Node's fetch (used by the CLI) only uses it with NODE_USE_ENV_PROXY=1.
  if (process.env.HTTPS_PROXY || process.env.https_proxy) env.NODE_USE_ENV_PROXY = '1';
  return { env, appId: token.split(':')[0] };
}

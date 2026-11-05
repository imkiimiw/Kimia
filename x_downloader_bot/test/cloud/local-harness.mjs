// Checks test/cloud/run-tests.mjs without the platform: starts the mock Bot API, points the runner
// at test/cloud/local-cli.mjs and a temporary database, and runs it. The X APIs and twimg are the
// real ones (set X_MOCK=1 to use test/mock-x.mjs instead, e.g. offline in CI).
//   NODE_USE_ENV_PROXY=1 node test/cloud/local-harness.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockTelegram } from '../mock-telegram.mjs';
import { createMockX } from '../mock-x.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OWNER = 5557901897;
const BOTFATHER = 93372553;
const tg = createMockTelegram({ botId: 7000000001 });
// The bot is admin in the three default channels, like a finished real setup; @telegram exists
// but the bot is not an admin there. Test users have no private chat (as on the platform).
tg.addChat('HIDE_i_SEEK', { title: 'Hide' });
tg.addChat('Nepenthw_ir', { title: 'Nepenthe' });
tg.addChat('wangerBots', { title: 'Wanger' });
tg.addChat('telegram', { title: 'Telegram', admin: false });
tg.state.users.add(OWNER);
tg.state.blocked.add(BOTFATHER);
const port = await tg.listen();
const env = { ...process.env, TG_MOCK_URL: `http://127.0.0.1:${port}` };
let mockX = null;
if (process.env.X_MOCK === '1') {
  mockX = createMockX();
  env.X_MOCK_URL = `http://127.0.0.1:${await mockX.listen()}`;
} else {
  delete env.X_MOCK_URL;
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcloud-local-'));

const child = spawn(process.execPath, ['test/cloud/run-tests.mjs'], {
  cwd: ROOT,
  stdio: 'inherit',
  env: {
    ...env,
    MOCK_DB_FILE: path.join(dir, 'db.sqlite'),
    TGCLOUD_CLI_ARGS: JSON.stringify(['--no-warnings', '--import', './test/sdk/register.mjs', 'test/cloud/local-cli.mjs']),
  },
});
const code = await new Promise((resolve) => child.on('exit', resolve));
await tg.close();
if (mockX) await mockX.close();
fs.rmSync(dir, { recursive: true, force: true });
process.exit(code);

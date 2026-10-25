// Checks test/cloud/run-tests.mjs without the platform: starts the mock Bot API, points the
// runner at test/cloud/local-cli.mjs and a temporary database, and runs it.
//   node test/cloud/local-harness.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockTelegram } from '../mock-telegram.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const mock = createMockTelegram({ botId: 7000000001 });
// The bot is admin in two of the three channels, like a half-finished real setup.
mock.addChat('HIDE_i_SEEK', { title: 'Hide' });
mock.addChat('Nepenthw_ir', { title: 'Nepenthe' });
mock.addChat('wangerBots', { title: 'Wanger', admin: false });
mock.addChat('telegram', { title: 'Telegram' });
const port = await mock.listen();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcloud-local-'));

const child = spawn(process.execPath, ['test/cloud/run-tests.mjs'], {
  cwd: ROOT,
  stdio: 'inherit',
  env: {
    ...process.env,
    TG_MOCK_URL: `http://127.0.0.1:${port}`,
    MOCK_DB_FILE: path.join(dir, 'db.sqlite'),
    TGCLOUD_CLI_ARGS: JSON.stringify(['--no-warnings', '--import', './test/sdk/register.mjs', 'test/cloud/local-cli.mjs']),
  },
});
const code = await new Promise((resolve) => child.on('exit', resolve));
await mock.close();
fs.rmSync(dir, { recursive: true, force: true });
process.exit(code);

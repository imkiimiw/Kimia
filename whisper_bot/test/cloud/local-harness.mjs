// Checks test/cloud/run-tests.mjs without the platform: starts the mock Bot API (set up to answer
// like real Telegram does for the runner's fake test users), points the runner at
// test/cloud/local-cli.mjs and a temporary database, and runs it.
//   node test/cloud/local-harness.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockTelegram } from '../mock-telegram.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OWNER = 5557901897;
const mock = createMockTelegram({ botId: 7000000001, botUsername: 'whisper_local_bot' });
for (const name of ['HIDE_i_SEEK', 'Nepenthw_ir', 'wangerBots']) mock.addChat(name, { title: name });
// Fake test ids are unknown to Telegram: "chat not found" for messages, "user not found" for members.
for (let id = 990000001; id <= 990000009; id += 1) mock.state.unknownUsers.add(id);
mock.state.blocked.add(93372553); // stands in for "bot can't send messages to bots" (403)
mock.state.privateChats.add(OWNER);
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

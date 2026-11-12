// Phase 0 platform measurements on the real Telegram Serverless runtime, without deploying.
//
//   npm run probe                 all tests below
//   npm run probe -- globals wasm only the named tests
//
// How: copies spike/probe.js to tgcloud/endpoints/zz_probe.js, runs it with
// `tgcloud run endpoints/zz_probe '<json5>' --ctx …` (local code executed on the platform; nothing
// is pushed), and ALWAYS deletes the copy afterwards (also on Ctrl-C). Never run `push` while this
// runs. The probe writes nothing to the database and sends no messages.
//
// Results: docs/probe-results.json (raw) — summarise them in docs/SPIKE_REPORT.md.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, runCli, cliEnv } from './tg.mjs';

const SRC = path.join(ROOT, 'spike/probe.js');
const DST = path.join(ROOT, 'tgcloud/endpoints/zz_probe.js');
const OUT = path.join(ROOT, 'docs/probe-results.json');
const CTX = "{ initData: { user: { id: 5557901897 } } }";

// Ladders: each step is one `tgcloud run`; a ladder stops at its first failure (that is the limit).
const PLAN = {
  globals: [{}],
  ownerMenu: [{}],
  mem: [{ n: 64 }, { n: 128 }, { n: 256 }, { n: 512 }],
  wasmValidate: [{}],
  wasmModule: [{}],
  dbBlobFine: [{ n: 0.375 }, { n: 0.5 }, { n: 0.625 }, { n: 0.75 }, { n: 0.875 }],
  dbTextFine: [{ n: 1.5 }, { n: 2 }, { n: 2.5 }, { n: 3 }],
  dbBlobResultFine: [{ n: 1.25 }, { n: 1.5 }, { n: 1.75 }],
  wasm: [{}],
  me: [{}],
  sha256: [{ n: 1 }, { n: 8 }, { n: 20 }],
  base64: [{ n: 1 }, { n: 2 }, { n: 4 }, { n: 8 }, { n: 16 }],
  cpu: [{ n: 5 }, { n: 10 }, { n: 20 }, { n: 30 }, { n: 40 }],
  dbBlobParam: [{ n: 0.25 }, { n: 1 }, { n: 2 }, { n: 4 }, { n: 8 }, { n: 16 }],
  dbBlobResult: [{ n: 0.25 }, { n: 1 }, { n: 2 }, { n: 4 }, { n: 8 }, { n: 16 }],
  dbTextParam: [{ n: 1 }, { n: 4 }, { n: 8 }],
  output: [{ n: 1 }, { n: 4 }, { n: 8 }],
  chat: [{ chat: '@HIDE_i_SEEK' }, { chat: '@Nepenthw_ir' }, { chat: '@wangerBots' }],
  wall: [{ n: 2 }, { n: 3 }, { n: 4 }],
};

const { error } = cliEnv();
if (error) {
  console.error(error);
  process.exit(1);
}

const wanted = process.argv.slice(2);
const names = wanted.length ? wanted : Object.keys(PLAN);
const cleanup = () => fs.rmSync(DST, { force: true });
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

fs.copyFileSync(SRC, DST);
const results = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
try {
  for (const name of names) {
    const steps = PLAN[name];
    if (!steps) {
      console.error(`unknown test ${name}`);
      continue;
    }
    results[name] = [];
    for (const params of steps) {
      const alias = { dbBlobFine: 'dbBlobParam', dbTextFine: 'dbTextParam', dbBlobResultFine: 'dbBlobResult' };
      const input = JSON.stringify({ test: alias[name] || name, ...params });
      const t0 = Date.now();
      const r = runCli(['run', 'endpoints/zz_probe', input, '--ctx', CTX], { capture: true });
      const entry = { params, code: r.code, wallMs: Date.now() - t0, stdout: r.stdout.slice(-4000), stderr: r.stderr.slice(-2000) };
      results[name].push(entry);
      console.log(`${name} ${JSON.stringify(params)} → exit ${r.code} (${entry.wallMs} ms)`);
      if (r.code !== 0) break; // first failure = the limit
      if (/Too many requests/i.test(r.stderr + r.stdout)) break;
    }
    results[name + ':at'] = new Date().toISOString();
  }
} finally {
  cleanup();
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2) + '\n');
  console.log(`\nwrote ${path.relative(ROOT, OUT)}; temporary module removed.`);
}

// Turns the output of `tgcloud webhook` into the input of endpoints/opsTick, so the bot can warn the
// owner about webhook problems (the bot itself may not call getWebhookInfo on this platform).
//   npx tgcloud webhook | node scripts/webhook-state.mjs   →   {"webhook":{"in_sync":true,"pending":0,…}}
// Prints {"from":"github"} alone when the output can't be read (no false webhook alarm).

/** @param {string} text CLI output @returns {{webhook?: {in_sync: boolean, pending: number, last_error: string|null, last_error_at: number|null}}} */
export function parseWebhookOutput(text) {
  const s = String(text || '').replace(/\u001b\[[0-9;]*m/g, ''); // strip colors
  const pending = /pending updates:\s*(\d+)/.exec(s);
  const inSync = /✓ in sync with your deployed handlers/.test(s);
  const outOfSync = /OUT OF SYNC/.test(s);
  if (!pending || (!inSync && !outOfSync)) return {};
  const err = /last error:\s*(.+?)(?:\s+\((\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC\))?\s*$/m.exec(s);
  const at = err && err[2] ? Date.parse(`${err[2]}T${err[3]}:00Z`) / 1000 : null;
  return { webhook: { in_sync: inSync && !outOfSync, pending: Number(pending[1]), last_error: err ? err[1].trim().slice(0, 200) : null, last_error_at: Number.isFinite(at) ? at : null } };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { input += d; });
  // from: the bot counts only these runs as the GitHub schedule (manual `tgcloud run` calls don't)
  process.stdin.on('end', () => process.stdout.write(JSON.stringify({ from: 'github', ...parseWebhookOutput(input) })));
}

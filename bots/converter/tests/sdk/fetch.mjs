// The SDK's fetch in tests: no network. A test installs a handler (url, init) → { status, body }.
let handler = null;
export function setFetchHandler(fn) {
  handler = fn;
}
export const fetch = async (url, init = {}) => {
  if (!handler) throw new Error(`fetch(${url}) is not available in tests`);
  const r = await handler(String(url), init);
  if (r instanceof Error) throw r;
  const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? null);
  let used = false;
  const read = () => { if (used) throw new TypeError('body used already'); used = true; return body; };
  return { status: r.status ?? 200, ok: (r.status ?? 200) >= 200 && (r.status ?? 200) < 300, url: String(url), headers: { get: () => null }, text: async () => read(), json: async () => JSON.parse(read()) };
};

// Local stand-in for sdk `fetch`. The response mirrors what the platform documents: status, ok,
// statusText, url, headers.get(), text(), json() and a body streamed as Uint8Array chunks — and
// deliberately no arrayBuffer(), so the bot can't depend on it. A response is capped at 30 MB.
//
// With X_MOCK_URL set, the X APIs and twimg hosts are served by test/mock-x.mjs; any other host
// fails like an unresolvable name. Without it, requests go to the real internet (LIVE tests).
const CAP = 30 * 1024 * 1024;

const ROUTES = {
  'api.fxtwitter.com': '/fx',
  'api.vxtwitter.com': '/vx',
  'video.twimg.com': '/video',
  'pbs.twimg.com': '/pbs',
};

function target(url) {
  const m = /^https:\/\/([^/]+)(\/.*)?$/i.exec(url);
  if (!m) throw new TypeError(`fetch failed: invalid URL ${url}`);
  if (!process.env.X_MOCK_URL) return url;
  const prefix = ROUTES[m[1].toLowerCase()];
  if (!prefix) throw new TypeError(`fetch failed: getaddrinfo ENOTFOUND ${m[1]}`);
  return `${process.env.X_MOCK_URL}${prefix}${m[2] || '/'}`;
}

class Headers {
  constructor(h) {
    this.map = new Map();
    for (const [k, v] of h) this.map.set(k.toLowerCase(), v);
  }
  get(k) {
    return this.map.has(k.toLowerCase()) ? this.map.get(k.toLowerCase()) : null;
  }
  has(k) {
    return this.map.has(k.toLowerCase());
  }
  keys() {
    return this.map.keys();
  }
  entries() {
    return this.map.entries();
  }
}

export async function fetch(url, init = {}) {
  const real = target(String(url));
  const res = await globalThis.fetch(real, { method: init.method || 'GET', headers: init.headers, body: init.body, redirect: 'follow' });
  let used = false;
  let total = 0;
  const stream = res.body;
  const take = () => {
    if (used) throw new TypeError('body used already');
    used = true;
  };
  async function* chunks() {
    if (!stream) return;
    for await (const c of stream) {
      total += c.length;
      if (total > CAP) throw new TypeError('response exceeds the 30 MB limit');
      yield new Uint8Array(c);
    }
  }
  const body = {
    [Symbol.asyncIterator]() {
      take();
      return chunks();
    },
    async cancel() {
      used = true;
      if (stream) await stream.cancel().catch(() => {});
    },
  };
  const text = async () => {
    take();
    const parts = [];
    for await (const c of chunks()) parts.push(c);
    return Buffer.concat(parts).toString('utf8');
  };
  const finalUrl = process.env.X_MOCK_URL ? String(url) : res.url;
  return {
    status: res.status,
    ok: res.ok,
    statusText: res.statusText,
    url: finalUrl,
    headers: new Headers(res.headers),
    get bodyUsed() {
      return used;
    },
    body,
    text,
    json: async () => JSON.parse(await text()),
  };
}

// A fake web for the SDK's fetch: routes URLs to recorded responses (test/fixtures) or to
// generated files, answers HEAD and Range like a CDN, and honours redirect: 'manual'. Every request
// is logged so tests can assert what the bot fetched (and that it fetched nothing it shouldn't).
import { readFileSync } from 'node:fs';
import { setFetch } from '../sdk/fetch.js';

export const fixture = (name) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');

function response({ status = 200, body = '', headers = {}, url }) {
  const bytes = body instanceof Uint8Array ? body : new TextEncoder().encode(String(body));
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  let used = false;
  const take = () => { if (used) throw new TypeError('body used already'); used = true; return bytes; };
  return {
    status, ok: status >= 200 && status < 300, url,
    headers: { get: (k) => h[k.toLowerCase()] ?? null, has: (k) => k.toLowerCase() in h },
    async text() { return new TextDecoder().decode(take()); },
    async json() { return JSON.parse(new TextDecoder().decode(take())); },
    body: {
      async *[Symbol.asyncIterator]() {
        const b = take();
        for (let i = 0; i < b.length; i += 1 << 20) yield b.subarray(i, Math.min(b.length, i + (1 << 20)));
      },
    },
  };
}

/**
 * Installs a fake web. routes: { [url | url prefix ending in '*']: handler } where handler is
 *   { json } | { html } | { status, body, headers } | { redirect: url } | { file: bytes, type } | (req) => same | Error
 * Files answer HEAD (Content-Length) and Range requests.
 */
export function createWeb(routes = {}) {
  const log = [];
  const find = (url) => {
    if (url in routes) return routes[url];
    const key = Object.keys(routes).filter((k) => k.endsWith('*') && url.startsWith(k.slice(0, -1))).sort((a, b) => b.length - a.length)[0];
    return key ? routes[key] : undefined;
  };
  setFetch(async (url, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    const headers = opts.headers || {};
    log.push({ url, method, range: headers.Range || null, ua: headers['User-Agent'] || null, redirect: opts.redirect || 'follow' });
    let r = find(url);
    if (typeof r === 'function') r = r({ url, method, headers });
    if (r instanceof Error) throw r;
    if (!r) return response({ status: 404, body: 'not found', url });
    if (r.redirect) {
      if (opts.redirect !== 'manual') throw new Error('test: the bot must follow redirects itself');
      return response({ status: 302, headers: { location: r.redirect }, url });
    }
    if (r.file || r.size) {
      const size = r.size ?? r.file.length;
      const bytesOf = (a, b) => (r.file ? r.file.subarray(a, b) : new Uint8Array(b - a)); // large files are made on demand
      const base = { 'content-type': r.type || 'video/mp4', 'accept-ranges': r.noRanges ? 'none' : 'bytes' };
      if (method === 'HEAD') return response({ status: 200, headers: r.noLength ? base : { ...base, 'content-length': size }, url });
      const m = /^bytes=(\d+)-(\d+)$/.exec(headers.Range || '');
      if (m && !r.noRanges) {
        const a = Number(m[1]);
        const b = Math.min(Number(m[2]), size - 1);
        return response({ status: 206, body: bytesOf(a, b + 1), headers: { ...base, 'content-range': `bytes ${a}-${b}/${size}`, 'content-length': b - a + 1 }, url });
      }
      return response({ status: 200, body: bytesOf(0, size), headers: r.noLength ? base : { ...base, 'content-length': size }, url });
    }
    if (r.json !== undefined) return response({ status: r.status || 200, body: typeof r.json === 'string' ? r.json : JSON.stringify(r.json), headers: { 'content-type': 'application/json' }, url });
    if (r.html !== undefined) return response({ status: r.status || 200, body: r.html, headers: { 'content-type': 'text/html' }, url });
    return response({ ...r, url });
  });
  return {
    log,
    routes,
    requests: (pattern) => log.filter((l) => (pattern instanceof RegExp ? pattern.test(l.url) : l.url.includes(pattern))),
    reset() { log.length = 0; },
  };
}

/** A file of `size` bytes (contents irrelevant). */
export const fileOf = (size) => new Uint8Array(size);

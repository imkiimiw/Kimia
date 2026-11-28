// The sdk's outbound `fetch` in the local emulation, on node:http / node:https: Node's own fetch
// needs the web globals (URL, Headers, …) that the e2e suite removes to mimic the bare isolate.
// The platform's client is web-like; this covers what the bot uses — method, headers, a string body;
// status, ok, statusText, url, headers.get/has, text(), json().
import { Buffer } from 'node:buffer';
import http from 'node:http';
import https from 'node:https';

export function fetch(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const target = String(url);
    const lib = target.startsWith('https:') ? https : http;
    const req = lib.request(target, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let used = false;
        const read = () => {
          if (used) throw new TypeError('body used already');
          used = true;
          return text;
        };
        resolve({
          status: res.statusCode,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          statusText: res.statusMessage || '',
          url: target,
          headers: { get: (k) => res.headers[String(k).toLowerCase()] ?? null, has: (k) => String(k).toLowerCase() in res.headers },
          text: async () => read(),
          json: async () => JSON.parse(read()),
        });
      });
    });
    req.on('error', reject);
    if (body !== undefined && body !== null) req.write(typeof body === 'string' ? body : String(body));
    req.end();
  });
}

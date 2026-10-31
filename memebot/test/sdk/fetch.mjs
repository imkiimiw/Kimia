// The SDK's fetch. Calls to the Gemini API (Phase 6) go to the mock's /gemini/ instead, through
// node:http (the e2e suite removes the web globals); everything else uses Node's fetch.
import { Buffer } from 'node:buffer';
import http from 'node:http';

const nodeFetch = globalThis.fetch;
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/';

function toMock(path, init) {
  const base = process.env.TG_MOCK_URL.replace(/^http:\/\//, '');
  const [host, port] = base.split(':');
  const body = init.body ? Buffer.from(String(init.body), 'utf8') : null;
  const headers = { ...(init.headers || {}), ...(body ? { 'content-length': body.length } : {}) };
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port: Number(port), path, method: init.method || 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          statusText: res.statusMessage,
          text: async () => text,
          json: async () => JSON.parse(text),
        });
      });
    });
    req.on('error', reject);
    req.end(body || undefined);
  });
}

export const fetch = (url, init = {}) => (String(url).startsWith(GEMINI) ? toMock(`/gemini/${String(url).slice(GEMINI.length)}`, init) : nodeFetch(url, init));

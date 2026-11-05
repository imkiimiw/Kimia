// Stand-in for api.fxtwitter.com, api.vxtwitter.com, video.twimg.com and pbs.twimg.com, replaying
// responses captured from the real services (test/fixtures/*, recorded 2026-11) and serving files
// with their real sizes (test/fixtures/sizes.tsv), with HEAD and Range support.
// A few extra posts are synthesized from those fixtures for cases no public post shows on demand
// (a private account, a media URL on a foreign host); their ids start with 9 and are marked below.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');

export const POSTS = {
  video: { id: '2118034216503955710', user: 'NASA' },
  photos: { id: '2112592291147747809', user: 'SpaceX' },
  gif: { id: '2090559778699489429', user: 'GIPHY' },
  text: { id: '20', user: 'jack' },
  twovid: { id: '2115476295169814978', user: 'SpaceX' },
  missing: { id: '1000000000000000000', user: 'jack' },
};

// Synthesized (not real posts): a private one, and one whose API answer points at a foreign host.
export const FAKE = {
  private: '9000000000000000001',
  evil: '9000000000000000002',
};

function loadFixtures() {
  const fx = new Map();
  const vx = new Map();
  for (const [name, p] of Object.entries(POSTS)) {
    const fxBody = read(`fx_${name}.json`);
    fx.set(p.id, { status: JSON.parse(fxBody).code === 404 ? 404 : 200, body: fxBody, type: 'application/json' });
    const vxBody = read(`vx_${name}.body`);
    vx.set(p.id, { status: 200, body: vxBody, type: vxBody.trim().startsWith('{') ? 'application/json' : 'text/html; charset=utf-8' });
  }
  fx.set(FAKE.private, { status: 401, body: JSON.stringify({ code: 401, message: 'PRIVATE_TWEET', tweet: null }), type: 'application/json' });
  vx.set(FAKE.private, vx.get(POSTS.missing.id));
  const evil = JSON.parse(read('fx_video.json'));
  evil.tweet.id = FAKE.evil;
  for (const m of [...evil.tweet.media.all, ...evil.tweet.media.videos]) {
    for (const v of [...m.variants, ...m.formats]) v.url = v.url.replace('https://video.twimg.com/', 'https://evil.example.com/');
    m.url = m.url.replace('https://video.twimg.com/', 'https://evil.example.com/');
  }
  fx.set(FAKE.evil, { status: 200, body: JSON.stringify(evil), type: 'application/json' });
  vx.set(FAKE.evil, vx.get(POSTS.missing.id));
  return { fx, vx };
}

function loadSizes() {
  const sizes = new Map();
  for (const line of read('sizes.tsv').split('\n')) {
    const [url, n] = line.split('\t');
    if (url && /^\d+$/.test(n || '')) sizes.set(url, Number(n));
  }
  return sizes;
}

export function createMockX() {
  const { fx, vx } = loadFixtures();
  const sizes = loadSizes();
  const state = {
    requests: [], // { host, path, method, range }
    fxDown: false, // FxTwitter answers 503
    vxDown: false,
    fxHtml: false, // FxTwitter answers an HTML page
  };

  function apiAnswer(res, table, down, id) {
    if (down) {
      res.writeHead(503, { 'content-type': 'text/html' });
      return res.end('<html>Service Unavailable</html>');
    }
    const hit = table.get(id);
    if (!hit) {
      const missing = table === fx ? fx.get(POSTS.missing.id) : vx.get(POSTS.missing.id);
      res.writeHead(missing.status, { 'content-type': missing.type });
      return res.end(missing.body);
    }
    res.writeHead(hit.status, { 'content-type': hit.type });
    return res.end(hit.body);
  }

  function file(req, res, url) {
    const total = sizes.get(url);
    if (!total) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    const type = /\.mp4/.test(url) ? 'video/mp4' : 'image/jpeg';
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'content-type': type, 'content-length': total, 'accept-ranges': 'bytes' });
      return res.end();
    }
    let start = 0;
    let end = total - 1;
    let status = 200;
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    if (range) {
      start = Number(range[1]);
      end = range[2] ? Math.min(total - 1, Number(range[2])) : total - 1;
      status = 206;
    }
    const len = end - start + 1;
    const headers = { 'content-type': type, 'content-length': len, 'accept-ranges': 'bytes' };
    if (status === 206) headers['content-range'] = `bytes ${start}-${end}/${total}`;
    res.writeHead(status, headers);
    // Deterministic bytes: byte i of the file is (i * 31) & 255.
    const step = 1024 * 1024;
    for (let off = start; off <= end; off += step) {
      const n = Math.min(step, end - off + 1);
      const chunk = Buffer.allocUnsafe(n);
      for (let i = 0; i < n; i += 1) chunk[i] = ((off + i) * 31) & 255;
      res.write(chunk);
    }
    return res.end();
  }

  const server = http.createServer((req, res) => {
    const m = /^\/(fx|vx|video|pbs)(\/.*)$/.exec(req.url);
    state.requests.push({ host: m ? m[1] : '?', path: m ? m[2] : req.url, method: req.method, range: req.headers.range || null });
    if (!m) {
      res.writeHead(404);
      return res.end();
    }
    const [, host, rest] = m;
    if (host === 'fx' || host === 'vx') {
      const id = (/\/status\/(\d+)/.exec(rest) || [])[1];
      if (host === 'fx' && state.fxHtml) {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end('<!DOCTYPE html><html>FxTwitter</html>');
      }
      return apiAnswer(res, host === 'fx' ? fx : vx, host === 'fx' ? state.fxDown : state.vxDown, id);
    }
    return file(req, res, `https://${host === 'video' ? 'video' : 'pbs'}.twimg.com${rest}`);
  });

  return {
    state,
    sizes,
    downloads: () => state.requests.filter((r) => (r.host === 'video' || r.host === 'pbs') && r.method === 'GET' && r.range !== 'bytes=0-0'),
    apiCalls: (api) => state.requests.filter((r) => r.host === api),
    reset: () => {
      state.requests.length = 0;
    },
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// `api.<method>(params)` → unwrapped result, or throws BotApiError, like the platform's Bot API client.
// Requests go to the mock Bot API at process.env.TG_MOCK_URL. It uses node:http with explicit imports,
// because the e2e suite removes web globals (fetch, URL, Blob, …) to mimic a bare V8 isolate.
import { Buffer } from 'node:buffer';
import http from 'node:http';

export class BotApiError extends Error {
  constructor(code, description, method, parameters) {
    super(description);
    this.code = code;
    this.description = description;
    this.method = method;
    this.parameters = parameters;
  }
}

export class InputFile {
  constructor(bytes, name, { type } = {}) {
    this.bytes = bytes;
    this.name = name;
    this.type = type;
  }
}

function post(path, body, contentType) {
  const base = process.env.TG_MOCK_URL.replace(/^http:\/\//, '');
  const [host, port] = base.split(':');
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host, port: Number(port), path, method: 'POST', headers: { 'content-type': contentType, 'content-length': body.length } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

function multipart(params) {
  const boundary = `----tgcloudtest${Date.now().toString(16)}`;
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    if (v instanceof InputFile) {
      parts.push(
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"; filename="${v.name}"\r\nContent-Type: ${v.type || 'application/octet-stream'}\r\n\r\n`),
        Buffer.from(v.bytes),
        Buffer.from('\r\n'),
      );
    } else {
      const value = typeof v === 'object' ? JSON.stringify(v) : String(v);
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${value}\r\n`));
    }
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${boundary}` };
}

/* Like the platform: an InputFile at any depth is uploaded (nested ones as attach://<name> parts). */
function lift(params) {
  const files = [];
  const walk = (v, top) => {
    if (v instanceof InputFile) {
      if (top) return v;
      const name = `file${files.length}`;
      files.push([name, v]);
      return `attach://${name}`;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, false));
    if (v && typeof v === 'object' && !(v instanceof Uint8Array)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, false)]));
    return v;
  };
  const out = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, walk(v, true)]));
  for (const [name, f] of files) out[name] = f;
  return out;
}

async function call(method, params0 = {}) {
  const path = `/botSERVERLESS/${method}`;
  const params = lift(params0);
  const hasFile = Object.values(params).some((v) => v instanceof InputFile);
  const data = hasFile
    ? await post(path, ...Object.values(multipart(params)))
    : await post(path, Buffer.from(JSON.stringify(params)), 'application/json');
  if (!data.ok) throw new BotApiError(data.error_code, data.description, method, data.parameters);
  if (method === 'getFileContent') return new Uint8Array(data.result); /* the platform gives the bytes */
  return data.result;
}

export const api = new Proxy({}, { get: (_, method) => (params) => call(method, params) });

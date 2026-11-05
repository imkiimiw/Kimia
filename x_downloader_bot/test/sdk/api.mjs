// `api.<method>(params)` -> unwrapped result, or throws BotApiError, like the platform's Bot API client.
// Requests go to the mock Bot API at process.env.TG_MOCK_URL as JSON; an InputFile at any depth
// becomes { __file: { name, type, size } } (the mock only needs to know a file was uploaded).
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
    if (!(bytes instanceof Uint8Array) && !(bytes instanceof ArrayBuffer)) throw new TypeError('InputFile needs a Uint8Array or ArrayBuffer');
    this.bytes = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
    this.name = name;
    this.type = type;
  }
}

function encode(value) {
  return JSON.stringify(value, (_, v) => {
    if (v instanceof InputFile) {
      const head = Array.from(v.bytes.slice(0, 12));
      return { __file: { name: v.name, type: v.type || null, size: v.bytes.length, head } };
    }
    return v;
  });
}

function post(path, body) {
  const base = process.env.TG_MOCK_URL.replace(/^http:\/\//, '');
  const [host, port] = base.split(':');
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host, port: Number(port), path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
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

async function call(method, params = {}) {
  const data = await post(`/botSERVERLESS/${method}`, encode(params));
  if (!data.ok) throw new BotApiError(data.error_code, data.description, method, data.parameters);
  return data.result;
}

export const api = new Proxy({}, { get: (_, method) => (params) => call(method, params) });

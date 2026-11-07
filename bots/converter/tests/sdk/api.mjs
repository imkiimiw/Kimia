// Local stand-in for the SDK's `api`: every call goes to the handler a test installs
// (tests/helpers/fake-telegram.mjs). Params are copied as they would travel over HTTP.
// getFileContent / getFileStream take a file_id string or { file_id }, like the real SDK.
export class BotApiError extends Error {
  constructor(code, description, method, parameters) {
    super(description);
    this.name = 'BotApiError';
    this.code = code;
    this.description = description;
    this.method = method;
    this.parameters = parameters;
  }
}

export class InputFile {
  constructor(bytes, name, { type } = {}) {
    if (!(bytes instanceof Uint8Array || bytes instanceof ArrayBuffer)) throw new TypeError('InputFile bytes must be a Uint8Array or ArrayBuffer');
    this.bytes = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
    this.name = name;
    this.type = type;
  }
}

let handler = null;
export function setApiHandler(fn) {
  handler = fn;
}

function wire(v) {
  if (v instanceof InputFile) return new InputFile(new Uint8Array(v.bytes), String(v.name), { type: v.type });
  if (v instanceof Uint8Array) return new Uint8Array(v);
  if (Array.isArray(v)) return v.map(wire);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined && typeof x !== 'function').map(([k, x]) => [k, wire(x)]));
  return v === undefined ? null : JSON.parse(JSON.stringify(v));
}

const fileParams = (p) => (typeof p === 'string' ? { file_id: p } : p);

export const api = new Proxy({}, {
  get: (_, method) => async (params = {}) => {
    if (!handler) throw new Error(`api.${String(method)} called with no fake Telegram installed`);
    const name = String(method);
    if (name === 'getFileStream') {
      const bytes = await handler('getFileContent', wire(fileParams(params)));
      const info = await handler('getFile', wire(fileParams(params)));
      let used = false;
      return {
        file: info,
        get bodyUsed() { return used; },
        body: { async *[Symbol.asyncIterator]() { used = true; for (let i = 0; i < bytes.length; i += 16384) yield bytes.subarray(i, i + 16384); } },
        async bytes() { used = true; return bytes; },
      };
    }
    if (name === 'getFileContent') return handler(name, wire(fileParams(params)));
    return handler(name, wire(params));
  },
});

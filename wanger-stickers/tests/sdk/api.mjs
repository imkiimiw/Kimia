// (Copied from wanger-music tests/sdk/api.mjs, 2026-11-12.)
// Local stand-in for the SDK's `api`: every call goes to the handler a test installs
// (tests/helpers/fake-telegram.mjs). Params are deep-copied, like a real HTTP call.
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
    this.bytes = bytes;
    this.name = name;
    this.type = type;
  }
}

let handler = null;
export function setApiHandler(fn) {
  handler = fn;
}

/** Params as they travel: JSON, except InputFile values, which the real SDK uploads as multipart parts. */
function wire(v) {
  if (v instanceof InputFile) {
    if (!(v.bytes instanceof Uint8Array || v.bytes instanceof ArrayBuffer)) throw new TypeError('InputFile bytes must be a Uint8Array or ArrayBuffer');
    return new InputFile(new Uint8Array(v.bytes), String(v.name), { type: v.type });
  }
  if (Array.isArray(v)) return v.map(wire);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined && typeof x !== 'function').map(([k, x]) => [k, wire(x)]));
  return v === undefined ? null : JSON.parse(JSON.stringify(v));
}

export const api = new Proxy({}, {
  get: (_, method) => async (params = {}) => {
    if (!handler) throw new Error(`api.${String(method)} called with no fake Telegram installed`);
    return handler(String(method), wire(params));
  },
});

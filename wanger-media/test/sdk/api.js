// Local stand-in for the SDK's `api`: every call goes to the handler a test installs
// (test/helpers/telegram.js). Params are deep-copied, like a real HTTP call.
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
export const setApiHandler = (fn) => { handler = fn; };

/** Deep copy like an HTTP call would make, with InputFile replaced by a small descriptor. */
function copy(v) {
  if (v instanceof InputFile) return { __file: v.name, type: v.type, size: v.bytes ? v.bytes.length ?? v.bytes.byteLength : 0 };
  if (Array.isArray(v)) return v.map(copy);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, copy(x)]));
  return v;
}

export const api = new Proxy({}, {
  get: (_, method) => async (params = {}) => {
    if (!handler) throw new Error(`api.${String(method)} called with no fake Telegram installed`);
    return handler(String(method), copy(params));
  },
});

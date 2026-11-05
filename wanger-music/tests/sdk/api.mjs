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

export const api = new Proxy({}, {
  get: (_, method) => async (params = {}) => {
    if (!handler) throw new Error(`api.${String(method)} called with no fake Telegram installed`);
    return handler(String(method), JSON.parse(JSON.stringify(params)));
  },
});

// Local stand-in for `sdk/fetch`. The node fetch is captured when this module loads (the e2e suite
// imports it before removing web globals). Tests route requests with fetchHooks.route(url, opts) → a
// { status, json } object (or null to fall through to the network, which the tests never do).
const nodeFetch = globalThis.fetch;

export const fetchHooks = { route: null, calls: [] };

class FakeResponse {
  constructor(status, body) {
    this.status = status;
    this.ok = status >= 200 && status < 300;
    this.statusText = String(status);
    this.bodyText = typeof body === 'string' ? body : JSON.stringify(body);
    this.bodyUsed = false;
    this.headers = { get: () => null, has: () => false };
  }

  async json() {
    if (this.bodyUsed) throw new TypeError('body used already');
    this.bodyUsed = true;
    return JSON.parse(this.bodyText);
  }

  async text() {
    if (this.bodyUsed) throw new TypeError('body used already');
    this.bodyUsed = true;
    return this.bodyText;
  }
}

/** The request body as an object (JSON body, or the fields of a FormData). */
function bodyOf(opts) {
  const b = opts && opts.body;
  if (!b) return null;
  if (b.__json !== undefined) return b.__json;
  if (b instanceof FormData) return Object.fromEntries(b.entries);
  if (typeof b === 'string') {
    try {
      return JSON.parse(b);
    } catch {
      return b;
    }
  }
  return b;
}

export const fetch = async (url, opts = {}) => {
  if (fetchHooks.route) {
    const body = bodyOf(opts);
    fetchHooks.calls.push({ url: String(url), method: opts.method || 'GET', body });
    const r = await fetchHooks.route(String(url), { ...opts, parsed: body });
    if (r) {
      if (r.throw) throw new Error(r.throw);
      return new FakeResponse(r.status || 200, r.json !== undefined ? r.json : r.text || '');
    }
  }
  if (!nodeFetch) throw new Error('network is not available in tests');
  return nodeFetch(url, opts);
};

fetch.body = {
  json: (v) => ({ __json: v, toString: () => JSON.stringify(v) }),
  form: (v) => ({ __json: v }),
  text: (v) => ({ __json: v }),
};

export class FormData {
  constructor() {
    this.entries = [];
  }

  append(k, v) {
    this.entries.push([k, v]);
  }
}

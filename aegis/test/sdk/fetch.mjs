const nodeFetch = globalThis.fetch;

/* Outbound HTTP like the platform's. Tests can put a stand-in in front of the network with stubFetch(fn)
 * (and remove it with stubFetch(null)) — the suites never reach outside services. */
let impl = null;
export const fetch = (...args) => (impl ? impl(...args) : nodeFetch(...args));
export const stubFetch = (fn) => {
  impl = fn || null;
};

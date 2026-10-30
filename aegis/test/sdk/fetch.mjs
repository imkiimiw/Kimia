const nodeFetch = globalThis.fetch;

export const fetch = (...args) => nodeFetch(...args);

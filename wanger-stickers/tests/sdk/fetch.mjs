// (Copied from wanger-music tests/sdk/fetch.mjs, 2026-11-12.)
// The SDK's fetch: tests have no network.
export const fetch = async (url) => {
  throw new Error(`fetch(${url}) is not available in tests`);
};

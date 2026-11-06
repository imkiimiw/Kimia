// The SDK's fetch: tests never call real platforms. A test may install a fake with setFetch().
let impl = null;
export const setFetch = (fn) => { impl = fn; };
export const fetch = async (url, opts) => {
  if (!impl) throw new Error(`fetch(${url}) is not available in tests`);
  return impl(url, opts);
};

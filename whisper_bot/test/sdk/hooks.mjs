// Module resolution like the platform's: inside tgcloud/, only `sdk`, `sdk/db`, `sdk/api`, `sdk/fetch`
// and relative imports ending in `.js` that stay inside tgcloud/ are allowed. Anything else throws,
// so a module that would fail to deploy fails here too.
const MODULES = { sdk: 'index.mjs', 'sdk/db': 'db.mjs', 'sdk/api': 'api.mjs', 'sdk/fetch': 'fetch.mjs' };

export async function resolve(specifier, context, next) {
  if (specifier in MODULES) return { url: new URL(MODULES[specifier], import.meta.url).href, shortCircuit: true };
  const parent = context.parentURL || '';
  const m = /^(file:\/\/.*\/tgcloud\/)/.exec(parent);
  if (m && !parent.includes('/node_modules/')) {
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
      throw new Error(`${parent}: import "${specifier}" is not available on the platform (only sdk and relative .js modules)`);
    }
    if (!specifier.endsWith('.js')) throw new Error(`${parent}: relative import "${specifier}" must end in .js`);
    const target = new URL(specifier, parent).href;
    if (!target.startsWith(m[1])) throw new Error(`${parent}: import "${specifier}" leaves tgcloud/`);
  }
  return next(specifier, context);
}

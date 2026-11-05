const MODULES = { sdk: 'index.mjs', 'sdk/db': 'db.mjs', 'sdk/api': 'api.mjs', 'sdk/fetch': 'fetch.mjs' };

export async function resolve(specifier, context, next) {
  if (specifier in MODULES) return { url: new URL(MODULES[specifier], import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
}

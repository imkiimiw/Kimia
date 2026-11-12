// (Copied from wanger-music tests/sdk/register.mjs, 2026-11-12.)
// `node --import ./tests/sdk/register.mjs …` makes `import … from 'sdk'` resolve to the local emulation.
import { register } from 'node:module';

register('./hooks.mjs', import.meta.url);

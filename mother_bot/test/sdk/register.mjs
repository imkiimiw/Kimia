// `node --import ./test/sdk/register.mjs …` makes `import … from 'sdk'` resolve to this local emulation.
import { register } from 'node:module';

register('./hooks.mjs', import.meta.url);

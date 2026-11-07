// `node --import ./tests/sdk/register.mjs …` (from bots/converter/) makes `import … from 'sdk'` resolve to the local emulation.
import { register } from 'node:module';

register('./hooks.mjs', import.meta.url);

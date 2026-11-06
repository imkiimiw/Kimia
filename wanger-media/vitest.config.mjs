// Local tests only (never deployed). The platform's `sdk` modules are mapped to the stand-ins in
// test/sdk/, which run SQL on node:sqlite and route Bot API calls to a fake Telegram.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^sdk$/, replacement: here('./test/sdk/index.js') },
      { find: /^sdk\/db$/, replacement: here('./test/sdk/db.js') },
      { find: /^sdk\/api$/, replacement: here('./test/sdk/api.js') },
      { find: /^sdk\/fetch$/, replacement: here('./test/sdk/fetch.js') },
    ],
  },
  test: {
    include: ['test/**/*.test.js'],
    environment: 'node',
    pool: 'forks',
  },
});

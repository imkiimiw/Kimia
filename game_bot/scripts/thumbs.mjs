// Renders the game artwork (app/art.js) to 256×256 PNGs in public/thumbs/: the inline-mode result
// thumbnails, served with the Mini App at <APP_URL>thumbs/<game>.png. Uses the preinstalled Chromium
// through Playwright. Run: npm run thumbs
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ART } from '../app/art.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'thumbs');
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 256, height: 256 } });
for (const [game, svg] of Object.entries(ART)) {
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', '<svg width="256" height="256" ')}</body></html>`);
  await page.screenshot({ path: path.join(OUT, `${game}.png`), omitBackground: true });
  console.log(`thumbs/${game}.png`);
}
await browser.close();

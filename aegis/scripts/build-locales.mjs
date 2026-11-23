// aegis/locales/<lang>/*.json → tgcloud/lib/i18n/strings/<lang>.js (deployed modules can't read
// files outside tgcloud/, so the strings are compiled into modules), and the "site" namespace →
// webapp/site-strings.js for the landing page (webapp/about.html).
//   node scripts/build-locales.mjs           validate and write
//   node scripts/build-locales.mjs --check   validate and fail if a generated file is stale
import fs from 'node:fs';
import path from 'node:path';
import { LANGS, OUT_DIR, readLocales, render, renderSite, SITE_FILE, validate } from './locales.mjs';

const check = process.argv.includes('--check');
const { dicts, problems } = readLocales();
problems.push(...validate(dicts));
if (problems.length) {
  for (const p of problems) console.error(`✘ ${p}`);
  console.error(`\nlocales: ${problems.length} problem(s)`);
  process.exit(1);
}
fs.mkdirSync(OUT_DIR, { recursive: true });
let stale = 0;
for (const lang of LANGS) {
  const file = path.join(OUT_DIR, `${lang}.js`);
  const src = render(lang, dicts[lang]);
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (before === src) continue;
  if (check) {
    stale += 1;
    console.error(`✘ tgcloud/lib/i18n/strings/${lang}.js is out of date: run npm run locales`);
  } else fs.writeFileSync(file, src);
}
{
  const src = renderSite(dicts);
  const before = fs.existsSync(SITE_FILE) ? fs.readFileSync(SITE_FILE, 'utf8') : '';
  if (before !== src) {
    if (check) {
      stale += 1;
      console.error('✘ webapp/site-strings.js is out of date: run npm run locales');
    } else fs.writeFileSync(SITE_FILE, src);
  }
}
if (stale) process.exit(1);
console.log(`✔ locales: ${Object.keys(dicts.en).length} keys × ${LANGS.length} languages${check ? ' (up to date)' : ''}`);

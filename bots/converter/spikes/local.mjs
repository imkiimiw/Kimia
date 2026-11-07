// Runs the C0 benchmark cases locally in Node, as a baseline for the Serverless numbers.
//   node spikes/local.mjs [pdfPath]
// pdfPath: a large real PDF for the pdf_load cases (the C0 run used ISO 32000-1, 22.5 MB, 756 pages,
// https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/PDF32000_2008.pdf).
import fs from 'node:fs';
import { runCase } from './bench.js';

const env = { now: async () => performance.now() };
const cases = [
  { case: 'gen_text' }, { case: 'gen_random' },
  { case: 'crc32' },
  { case: 'zip_store' },
  { case: 'zip_deflate', level: 1 }, { case: 'zip_deflate', level: 6 },
  { case: 'zip_deflate', level: 6, random: true },
  { case: 'zip_many', count: 1000 },
  { case: 'gzip' },
  { case: 'pdf_images', then: 'ops' },
  { case: 'pdf_png' },
];
const pdfPath = process.argv[2];
if (pdfPath) {
  const bytes = new Uint8Array(fs.readFileSync(pdfPath));
  cases.push({ case: 'pdf_load', then: 'split', pdf: bytes }, { case: 'pdf_load', then: 'rotate', pdf: bytes });
}
for (const c of cases) {
  const { pdf, ...input } = c;
  const steps = await runCase(input, { ...env, bytes: pdf });
  console.log(JSON.stringify(input), JSON.stringify(steps));
}

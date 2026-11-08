// A minimal DOCX from plain text (OCR results, spec §7.1): one paragraph per line, right-to-left
// paragraphs for lines in Arabic script (Persian), left-to-right otherwise. Pure (fflate).
import { zipSync, strToU8 } from './vendor/fflate.js';

const xml = (s) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const RTL = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/;
const LTR = /[A-Za-z\u00c0-\u024f]/;

/** Paragraph direction: right-to-left when the first strong letter is Hebrew/Arabic script. */
export function isRtlLine(line) {
  for (const ch of line) {
    if (RTL.test(ch)) return true;
    if (LTR.test(ch)) return false;
  }
  return false;
}

function paragraph(line) {
  const rtl = isRtlLine(line);
  const ppr = rtl ? '<w:pPr><w:bidi/><w:jc w:val="right"/></w:pPr>' : '';
  const rpr = rtl ? '<w:rPr><w:rtl/><w:rFonts w:cs="Vazirmatn"/></w:rPr>' : '';
  return `<w:p>${ppr}<w:r>${rpr}<w:t xml:space="preserve">${xml(line)}</w:t></w:r></w:p>`;
}

export function textToDocx(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const body = lines.map(paragraph).join('');
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const types = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
  return zipSync({
    '[Content_Types].xml': [strToU8(types), { level: 6 }],
    '_rels/.rels': [strToU8(rels), { level: 6 }],
    'word/document.xml': [strToU8(doc), { level: 6 }],
  });
}

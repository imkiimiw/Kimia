// OCR with the Gemini API (spec §7.1, C3): the image (or a short PDF) goes inline with a strict prompt
// (only the text, paragraphs and line breaks kept, no translation or summary). The key is sent in
// the x-goog-api-key header — never in the URL, a log or a trace.
// Pure: request building and response parsing (tested); the network call is lib/jobs.js#geminiOcr.
import { toBase64, toBase64Bytes } from './base64.js';
import { ToolError } from './errors.js';

export const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
/** Stable models as listed by Google on 2026-11-08 (docs/DECISIONS.md C3), plus the "latest" alias. */
export const MODELS = ['gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-flash-latest'];
export const MIMES = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', pdf: 'application/pdf' };

export const PROMPT = [
  'Transcribe all text in this file exactly as written (OCR).',
  'Return ONLY the transcribed text: no introduction, no explanation, no Markdown, no code fences.',
  'Keep the original language(s) and characters (Persian, Arabic, English, digits as written). Do not translate, correct, summarize or reorder.',
  'Keep paragraphs and line breaks; separate pages with one blank line.',
  'If there is no readable text, return exactly: [NO_TEXT]',
].join('\n');

export function buildRequest(bytes, mime) {
  return {
    contents: [{ role: 'user', parts: [{ inline_data: { mime_type: mime, data: toBase64(bytes) } }, { text: PROMPT }] }],
    generationConfig: { temperature: 0, maxOutputTokens: 8192 },
  };
}

/**
 * The same request as JSON bytes, without ever holding the image as a string (the JS heap is small
 * on Serverless; typed arrays are not). → Uint8Array for fetch's body.
 */
export function requestBody(bytes, mime) {
  const enc = new TextEncoder();
  const head = enc.encode(`{"contents":[{"role":"user","parts":[{"inline_data":{"mime_type":${JSON.stringify(mime)},"data":"`);
  const tail = enc.encode(`"}},{"text":${JSON.stringify(PROMPT)}}]}],"generationConfig":{"temperature":0,"maxOutputTokens":8192}}`);
  const b64 = toBase64Bytes(bytes);
  const out = new Uint8Array(head.length + b64.length + tail.length);
  out.set(head, 0);
  out.set(b64, head.length);
  out.set(tail, head.length + b64.length);
  return out;
}

/** A Gemini response → { text, finish, tokens }; refusals → ToolError. Pure. */
export function parseResponse(status, body) {
  let j = null;
  try { j = typeof body === 'string' ? JSON.parse(body) : body; } catch { j = null; }
  if (status !== 200) {
    const reason = j && j.error && Array.isArray(j.error.details) ? (j.error.details.find((d) => d.reason) || {}).reason : null;
    const st = j && j.error && j.error.status;
    if (status === 429 || st === 'RESOURCE_EXHAUSTED') throw new ToolError('GEMINI_QUOTA');
    if (reason === 'API_KEY_INVALID' || status === 401 || status === 403 || st === 'PERMISSION_DENIED') throw new ToolError('GEMINI_KEY');
    if (status === 400 && /location|region|country/i.test((j && j.error && j.error.message) || '')) throw new ToolError('GEMINI_REGION');
    if (status === 404) throw new ToolError('GEMINI_MODEL');
    if (status === 413 || (status === 400 && /size|too large|exceeds/i.test((j && j.error && j.error.message) || ''))) throw new ToolError('GEMINI_TOO_BIG');
    throw new ToolError('GEMINI_FAILED');
  }
  if (!j) throw new ToolError('GEMINI_FAILED');
  if (j.promptFeedback && j.promptFeedback.blockReason) throw new ToolError('GEMINI_BLOCKED');
  const c = Array.isArray(j.candidates) ? j.candidates[0] : null;
  if (!c) throw new ToolError('GEMINI_FAILED');
  if (['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII'].includes(c.finishReason)) throw new ToolError('GEMINI_BLOCKED');
  const text = ((c.content && c.content.parts) || []).map((p) => p.text || '').join('').replace(/^```[a-z]*\n?|\n?```$/g, '').trim();
  if (!text || text === '[NO_TEXT]') throw new ToolError('OCR_NO_TEXT');
  return { text, finish: c.finishReason || null, tokens: (j.usageMetadata && j.usageMetadata.totalTokenCount) || null, truncated: c.finishReason === 'MAX_TOKENS' };
}

/** Which scripts a text is in: 'arabic' (Persian/Arabic — can't be told apart), 'latin', 'mixed', 'other'. */
export function scriptOf(text) {
  let ar = 0;
  let la = 0;
  for (const ch of String(text)) {
    if (/[\u0600-ۿݐ-ݿﭐ-﷿ﹰ-\ufeff]/.test(ch)) ar++;
    else if (/[A-Za-zÀ-ɏ]/.test(ch)) la++;
  }
  if (!ar && !la) return 'other';
  if (ar && la) return ar / (ar + la) > 0.85 ? 'arabic' : la / (ar + la) > 0.85 ? 'latin' : 'mixed';
  return ar ? 'arabic' : 'latin';
}

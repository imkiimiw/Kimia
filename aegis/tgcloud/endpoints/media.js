/*
 * The media Mini App (webapp/media.html): reading text (OCR, Tesseract.js) and QR codes in a photo,
 * on the member's own device. { action: 'get', job } gives the page its texts and the photo (base64);
 * { action: 'send', job, text } sends the text read to the member's private chat. A job belongs to
 * the member who asked for it (ui/media.js); who is asking comes from the init data Telegram signs and
 * the platform verifies, never from the input.
 */
import { EndpointError } from 'sdk';
import * as errors from '../lib/core/errors.js';
import { base64 } from '../lib/core/files.js';
import { sniff } from '../lib/core/image.js';
import { call, createCtx, send } from '../lib/core/tg.js';
import { esc, toInt } from '../lib/core/util.js';
import * as fun from '../lib/engines/fun.js';
import * as users from '../lib/engines/users.js';
import { isRtl, pickLang, t } from '../lib/i18n/index.js';

const plain = (s) => String(s).replace(/[\u200F\u2068\u2069]/g, '');
const OCR_LANGS = { fa: 'fas+eng', en: 'eng', ru: 'rus+eng', zh: 'chi_sim+eng', fr: 'fra+eng' };

export default async function (input, pctx) {
  const init = (pctx && pctx.initData) || {};
  const user = init.user;
  if (!user) throw new EndpointError('No user', { code: 'NO_USER' });
  const u = await users.get(user.id);
  const lang = u && Number(u.lang_set) ? u.lang : pickLang(user.language_code);
  const j = await fun.job(toInt(input && input.job));
  if (!j || Number(j.user_id) !== user.id || j.kind !== 'photo') throw new EndpointError(plain(t(lang, 'media.gone')), { code: 'GONE' });
  const ctx = createCtx({ kind: 'endpoint' });
  try {
    if (input.action === 'send') {
      const text = String(input.text || '').trim().slice(0, 3500);
      if (!text) throw new EndpointError(plain(t(lang, 'media.app_empty')), { code: 'EMPTY' });
      await send(ctx, user.id, t(lang, 'media.app_sent_text', { text: `<code>${esc(text)}</code>` }), null, 'media-ocr-text');
      return { ok: true, text: plain(t(lang, 'media.app_sent')) };
    }
    const bytes = await call(ctx, 'getFileContent', { file_id: fun.jobData(j).big || j.file_id }, 'media-app-get');
    if (bytes.length > 6 * 1024 * 1024) throw new EndpointError(plain(t(lang, 'media.too_big')), { code: 'TOO_BIG' });
    const kind = sniff(bytes);
    const words = ['app_title', 'app_ocr', 'app_qr', 'app_lang', 'app_run', 'app_running', 'app_copy', 'app_copied', 'app_send', 'app_none', 'app_qr_none', 'app_note'];
    return {
      lang, rtl: isRtl(lang), ocrLang: OCR_LANGS[lang] || 'eng', mime: kind === 'png' ? 'image/png' : 'image/jpeg', image: base64(bytes),
      text: Object.fromEntries(words.map((w) => [w, plain(t(lang, `media.${w}`))])),
    };
  } catch (err) {
    if (err instanceof EndpointError) throw err;
    await errors.record(ctx, err, { source: 'endpoint.media', userId: user.id });
    throw err;
  }
}

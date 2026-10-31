/*
 * Inline mode: fires on every keystroke of @bot query.
 * The work is in lib/router.js. Returns the trace of Bot API calls (shown by `npx tgcloud run`).
 */
import { onInline } from '../lib/router.js';

export default async function (inlineQuery) {
  try {
    return await onInline(inlineQuery);
  } catch (err) {
    console.error('inline_query handler failed:', err);
    return { error: String((err && err.message) || err) };
  }
}

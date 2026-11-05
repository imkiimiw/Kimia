// Fires on every keystroke of "@bot …": answers with the whisper being typed (personal, uncached).
import { onInlineQuery } from '../lib/router.js';

export default async function (inlineQuery) {
  try {
    return await onInlineQuery(inlineQuery);
  } catch (err) {
    console.error('inline_query handler failed:', err);
    return { error: true };
  }
}

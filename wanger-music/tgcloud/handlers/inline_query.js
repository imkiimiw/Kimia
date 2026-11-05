// handlers/inline_query — @Wange_Musicbot <query> in any chat. No dedupe, never a tick (must be fast).
import { runHandler } from '../lib/core/boundary.js';
import { onInlineQuery } from '../lib/bot/router.js';

export default function (inlineQuery, ctx) {
  return runHandler('inline_query', inlineQuery, ctx, (app) => onInlineQuery(app, inlineQuery), { dedupe: false, tick: false });
}

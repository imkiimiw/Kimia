// handlers/message_reaction_count — reaction totals of channel posts (the bot is admin there): kept on
// the publication for «❤️ most liked posts» and the weekly chart. Idempotent (a total), so no dedupe row.
import { runHandler } from '../lib/core/boundary.js';
import { onReactionCount } from '../lib/bot/router.js';

export default function (update, ctx) {
  return runHandler('message_reaction_count', update, ctx, (app) => onReactionCount(app, update), { dedupe: false });
}

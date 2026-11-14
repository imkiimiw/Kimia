// POST /api/ai_suggest { text?, mood?, kind } — suggestions for the Studio through the AiProvider
// interface (lib/ai/provider.js): emojis for a sticker's text, or caption ideas for a mood.
import { EndpointError } from 'sdk';
import { runEndpoint } from '../lib/endpoint.js';
import { IDEA_MOODS } from '../lib/core/suggest.js';

export default function (input, ctx) {
  return runEndpoint('ai_suggest', input, ctx, { kind: 'string', text: 'string?', mood: 'string?' }, async (app, i) => {
    if (i.kind === 'emojis') return { provider: app.ai.name, emojis: app.ai.suggestEmojis(i.text || '') };
    if (i.kind === 'captions') {
      const mood = IDEA_MOODS.includes(i.mood) ? i.mood : 'funny';
      return { provider: app.ai.name, captions: app.ai.captionIdeas(app.lang, mood, 4) };
    }
    throw new EndpointError('Bad kind', { code: 'BAD_INPUT', field: 'kind' });
  }, { gate: false });
}

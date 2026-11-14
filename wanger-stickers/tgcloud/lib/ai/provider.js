// The AiProvider interface (brief §14 Phase 5: "AI … through free-tier providers behind one
// AiProvider interface"). Every AI feature calls only this.
//
//   suggestEmojis(text)            → string[] (1–3)
//   captionIdeas(lang, mood, n)    → string[]
//   generateSticker(prompt, opts)  → { bytes, format } | throws 'ai.err.unavailable'
//
// Only the LOCAL provider exists today: rule-based suggestions (lib/core/suggest.js), no key, no
// network. Image generation and the character studio need an external free-tier provider and a key
// that only the owner can create (brief §1: free services only; keys never in code) — the setting
// `ai.provider` names one and its key goes in 🔑 secrets; until then `generateSticker` refuses and
// the AI buttons stay hidden (flags.ai off). User media is never sent to a provider for training.
import { suggestEmojis, captionIdeas } from '../core/suggest.js';
import { UserError } from '../core/util.js';

/** @param {any} app */
export function createAi(app) {
  const local = {
    name: 'local',
    canGenerate: false,
    suggestEmojis: (text) => suggestEmojis(String(text || '').slice(0, 500)),
    captionIdeas: (lang, mood, n = 4) => captionIdeas(lang, mood, n, (app.clock.now() % 97) / 97),
    async generateSticker() {
      throw new UserError('ai.err.unavailable');
    },
  };
  // external providers plug in here (by `ai.provider` + a key in secrets) once the owner chooses one
  return local;
}

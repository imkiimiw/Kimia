// MusicProvider interface and the MVP provider: our own catalog (audio = a Telegram file_id).
// External providers (later) may give metadata and covers only; a result without deliverable
// audio is never offered as playable. Metadata, audio availability and delivery stay separate.

/**
 * @typedef {{search: boolean, metadata: boolean, cover: boolean, audio: 'telegram_file'|'none'}} ProviderCapabilities
 * @typedef {{title: string|null, artist: string|null, album: string|null, duration: number, genre: string|null, language: string}} TrackMetadata
 * @typedef {{
 *   id: string,
 *   capabilities: ProviderCapabilities,
 *   search: (query: string, opts?: {limit?: number}) => Promise<any[]>,
 *   getTrack: (ref: string) => Promise<any|null>,
 *   getMetadata: (ref: string) => Promise<TrackMetadata|null>,
 *   getCover: (ref: string) => Promise<string|null>,
 * }} MusicProvider
 */

/** Only active tracks are visible through the provider. */
const visible = (tr) => (tr && tr.status === 'active' ? tr : null);

/**
 * @param {{repo: any, key: (s: string) => string}} deps tracks repository and the key normalizer
 * @returns {MusicProvider}
 */
export function createCatalogProvider({ repo, key }) {
  return {
    id: 'catalog',
    capabilities: { search: true, metadata: true, cover: true, audio: 'telegram_file' },
    /** Prefix search over active tracks (Phase 3 replaces this with the track_terms index). */
    async search(query, { limit = 20 } = {}) {
      const k = key(query);
      return k.length < 2 ? [] : repo.searchPrefix(k, ['active'], limit);
    },
    getTrack: async (ref) => visible(await repo.getByPublicId(ref)),
    async getMetadata(ref) {
      const tr = visible(await repo.getByPublicId(ref));
      return tr ? { title: tr.title, artist: tr.artist, album: tr.album, duration: tr.duration, genre: tr.genre, language: tr.language } : null;
    },
    getCover: async (ref) => {
      const tr = visible(await repo.getByPublicId(ref));
      return tr ? tr.cover_file_id || null : null;
    },
  };
}

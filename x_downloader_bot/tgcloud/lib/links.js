// Finds X/Twitter post links in a message: x.com, twitter.com, mobile.twitter.com, fxtwitter.com,
// fixupx.com, vxtwitter.com, fixvx.com (with or without https://, www./m./mobile./d./g.), as
// /<user>/status/<id>, /i/status/<id> or /i/web/status/<id>. Anything after the id — /photo/1,
// /video/1, ?s=20&t=…, #fragment — is ignored. Hidden links (text_link entities) count too.

const HOSTS = 'x|twitter|fxtwitter|fixupx|vxtwitter|fixvx';
const LINK = new RegExp(
  String.raw`(?<![\w.@-])(?:https?:\/\/)?(?:(?:www|mobile|m|d|g)\.)?(?:${HOSTS})\.com\/(?:#!\/)?`
  + String.raw`(?:i\/web\/status|i\/status|([A-Za-z0-9_]{1,15})\/status(?:es)?)\/0*([1-9]\d{0,19})(?!\d)`,
  'gi',
);

/**
 * All distinct posts linked in `text` (and in the URL of text_link entities), in order.
 * Returns [{ id: '2118034216503955710', username: 'NASA' | null }]; ids stay strings.
 */
export function extractLinks(text, entities) {
  const sources = [String(text || '')];
  for (const e of entities || []) if (e && e.type === 'text_link' && e.url) sources.push(e.url);
  const seen = new Set();
  const out = [];
  for (const src of sources) {
    const clean = src.replace(/[​-‏⁠﻿]/g, '');
    for (const m of clean.matchAll(LINK)) {
      const id = m[2];
      if (seen.has(id)) continue;
      seen.add(id);
      const username = m[1] && m[1].toLowerCase() !== 'i' ? m[1] : null;
      out.push({ id, username });
    }
  }
  return out;
}

/** The canonical link shown in captions. */
export function postUrl(id, username) {
  return `https://x.com/${username || 'i'}/status/${id}`;
}

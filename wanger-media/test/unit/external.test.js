// The owner's external service client (lib/external.js): config validation and strict answers.
import { describe, expect, it } from 'vitest';
import { MB } from '../../tgcloud/lib/config.js';
import { configFrom, itemFrom, normalizeBase, postFrom, RISK_NOTE, validKey } from '../../tgcloud/lib/external.js';

const KEY = 'abcdefghijklmnop1234';
const cfg = configFrom({ url: 'https://dl.owner.net', key: KEY, relay: true });
const ref = { key: 'reddit:abc', url: 'https://www.reddit.com/comments/abc/', account: null };
const code = (fn) => { try { fn(); } catch (err) { return err.code; } return 'no error'; };

describe('external service config', () => {
  it('addresses: https on a public host only, no query; trailing slashes dropped', () => {
    expect(normalizeBase('https://dl.owner.net/')).toBe('https://dl.owner.net');
    expect(normalizeBase(' https://owner.net/svc/ ')).toBe('https://owner.net/svc');
    for (const bad of ['http://dl.owner.net', 'https://127.0.0.1', 'https://localhost', 'https://a.local', 'https://dl.owner.net/?k=1', 'ftp://x.net', 'https://user@dl.owner.net', '']) {
      expect(normalizeBase(bad), bad).toBeNull();
    }
  });

  it('keys: 16–200 visible characters; a config needs address and key; the relay limit is clamped', () => {
    expect(validKey(KEY)).toBe(true);
    for (const bad of ['short', 'has space inside!!!!', 'x'.repeat(201), null]) expect(validKey(bad)).toBe(false);
    expect(cfg).toMatchObject({ url: 'https://dl.owner.net', host: 'dl.owner.net', relay: true, maxMb: 500, maxBytes: 500 * MB });
    expect(configFrom({ url: 'https://dl.owner.net', key: KEY, max_mb: 5000 }).maxMb).toBe(500);
    expect(configFrom({ url: 'https://dl.owner.net', key: KEY, max_mb: 2000 }).maxMb).toBe(2000);
    expect(configFrom({ url: 'https://dl.owner.net' })).toBeNull();
    expect(configFrom(null)).toBeNull();
  });

  it('has a risk note in every language', () => {
    for (const l of ['fa', 'en', 'ru']) expect(RISK_NOTE[l].length).toBeGreaterThan(100);
  });
});

describe('external service answers', () => {
  it('items: known types, https on the service host only', () => {
    expect(itemFrom({ type: 'video', url: 'https://dl.owner.net/f/1.mp4', bytes: 1234.4, width: 640 }, 'dl.owner.net')).toEqual({
      type: 'video', width: 640, height: undefined, duration: undefined, variants: [{ url: 'https://dl.owner.net/f/1.mp4', bytes: 1234, mime: undefined }],
    });
    expect(itemFrom({ type: 'audio', url: 'https://dl.owner.net/f/1.mp3' }, 'dl.owner.net').type).toBe('audio');
    for (const it of [{ type: 'document', url: 'https://dl.owner.net/a.exe' }, { type: 'video', url: 'https://cdn.other.net/a.mp4' }, { type: 'video', url: 'http://dl.owner.net/a.mp4' }, { type: 'video' }, null]) {
      expect(itemFrom(it, 'dl.owner.net')).toBeNull();
    }
  });

  it('codes map to the usual reasons; anything malformed is "unavailable"', () => {
    const cases = { NOT_FOUND: 'not_found', PRIVATE: 'private', DRM: 'drm', TOO_LARGE: 'too_big', UNSUPPORTED: 'unsupported', RATE_LIMITED: 'unavailable', ERROR: 'unavailable', WHATEVER: 'unavailable' };
    for (const [c, reason] of Object.entries(cases)) expect(code(() => postFrom({ ok: false, code: c }, 200, cfg, 'reddit', ref)), c).toBe(reason);
    expect(code(() => postFrom(null, 502, cfg, 'reddit', ref))).toBe('unavailable');
    expect(code(() => postFrom({ ok: true, items: [{ type: 'video', url: 'https://evil.net/x.mp4' }] }, 200, cfg, 'reddit', ref))).toBe('no_media');
    const p = postFrom({ ok: true, title: 'T', author: 'A', items: [{ type: 'photo', url: 'https://dl.owner.net/p.jpg', bytes: 10 }] }, 200, cfg, 'reddit', ref);
    expect(p).toMatchObject({ platform: 'reddit', method: 'external', key: 'reddit:abc', title: 'T', author: 'A', mediaHosts: ['dl.owner.net'] });
  });
});

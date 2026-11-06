import { describe, expect, it } from 'vitest';
import { LANGS } from '../../tgcloud/lib/config.js';
import { metaTags, resolveLocation } from '../../tgcloud/lib/platforms/common.js';
import * as registry from '../../tgcloud/lib/platforms/index.js';
import { fromPinInfo, pinIdFromPath } from '../../tgcloud/lib/platforms/pinterest.js';
import { fromSpotlightHtml } from '../../tgcloud/lib/platforms/snapchat.js';
import { fromFxTwitter, fromSyndication, photoVariants, syndicationToken } from '../../tgcloud/lib/platforms/x.js';
import { parseUrl } from '../../tgcloud/lib/url.js';
import { fixture } from '../helpers/web.js';

const id = (link) => registry.identify(link);
const json = (name) => JSON.parse(fixture(name));

describe('identifying links', () => {
  it('X post links in every common form', () => {
    for (const l of ['https://x.com/SpaceX/status/2115476295169814978', 'https://twitter.com/SpaceX/status/2115476295169814978/video/1',
      'https://mobile.twitter.com/SpaceX/status/2115476295169814978?s=20', 'https://x.com/i/web/status/2115476295169814978',
      'https://fxtwitter.com/SpaceX/status/2115476295169814978', 'http://www.x.com/i/status/2115476295169814978']) {
      const r = id(l);
      expect(r.kind, l).toBe('post');
      expect(r.adapter.id).toBe('x');
      expect(r.ref.key).toBe('x:2115476295169814978');
    }
    expect(id('https://x.com/SpaceX/status/2115476295169814978').ref.account).toBe('x:spacex');
  });

  it('Pinterest pins (any country domain, slug ids) and pin.it short links', () => {
    expect(id('https://www.pinterest.com/pin/424605071146271645/').ref.key).toBe('pinterest:424605071146271645');
    expect(id('https://de.pinterest.com/pin/424605071146271645/').ref.key).toBe('pinterest:424605071146271645');
    expect(id('https://pinterest.co.uk/pin/some-title--424605071146271645/').ref.key).toBe('pinterest:424605071146271645');
    expect(id('https://pin.it/4X1y2Zq').ref).toMatchObject({ short: '4X1y2Zq', key: null });
    expect(pinIdFromPath('/pin/abc/')).toBeNull();
  });

  it('Snapchat Spotlight links (with or without @user) and /t/ short links', () => {
    const s = 'W7_EDlXWTBiXAEEniNoMPwAAYYm1kc21qZXdyAaGq_FkdAaGq_Af0AAAAAA';
    expect(id(`https://www.snapchat.com/spotlight/${s}`).ref.key).toBe('snapchat:' + s);
    expect(id(`https://www.snapchat.com/@emeriefjones2/spotlight/${s}`).ref).toMatchObject({ key: 'snapchat:' + s, account: 'snapchat:emeriefjones2' });
    expect(id('https://snapchat.com/t/AbCd1234').ref.short).toBe('AbCd1234');
  });

  it('the right platform but the wrong kind of link', () => {
    for (const l of ['https://x.com/SpaceX', 'https://x.com/home', 'https://www.pinterest.com/pinterest/', 'https://story.snapchat.com/s/abc', 'https://www.snapchat.com/add/user']) {
      expect(id(l).kind, l).toBe('unsupported_kind');
    }
  });

  it('platforms not built yet, Telegram links, unknown sites, and refused URLs', () => {
    expect(id('https://vm.tiktok.com/ZMabc/')).toEqual({ kind: 'not_built', platform: 'tiktok' });
    expect(id('https://youtu.be/dQw4w9WgXcQ')).toEqual({ kind: 'not_built', platform: 'youtube' });
    expect(id('https://www.instagram.com/p/abc/')).toEqual({ kind: 'not_built', platform: 'instagram' });
    expect(id('https://t.me/wangerBots/12').kind).toBe('telegram');
    expect(id('https://example.org/a').kind).toBe('unknown');
    expect(id('http://127.0.0.1/x.com/a/status/1').kind).toBe('invalid');
    expect(id('https://x.com.evil.com/a/status/1').kind).toBe('unknown');
  });
});

describe('X responses (recorded from Serverless)', () => {
  const ref = id('https://x.com/SpaceX/status/2115476295169814978').ref;
  it('a post with two videos → two video items, MP4 variants only, highest bitrate first', () => {
    const p = fromSyndication(json('syn_video.json'), ref);
    expect(p).toMatchObject({ platform: 'x', method: 'public', author: '@SpaceX', sensitive: false });
    expect(p.items.map((i) => i.type)).toEqual(['video', 'video']);
    for (const it of p.items) {
      expect(it.variants.length).toBeGreaterThan(2);
      expect(it.variants.every((v) => /^https:\/\/video\.twimg\.com\/.*\.mp4/.test(v.url))).toBe(true);
      const rates = it.variants.map((v) => v.bitrate);
      expect([...rates].sort((a, b) => b - a)).toEqual(rates);
    }
  });

  it('photos → original-size variants first; a GIF → one MP4; a text post → no media', () => {
    const photos = fromSyndication(json('syn_photos.json'), ref);
    expect(photos.items.map((i) => i.type)).toEqual(['photo', 'photo', 'photo']);
    expect(photos.items[0].variants[0].url).toMatch(/^https:\/\/pbs\.twimg\.com\/media\/.+name=orig$/);
    const gif = fromSyndication(json('syn_gif.json'), ref);
    expect(gif.items).toHaveLength(1);
    expect(gif.items[0].type).toBe('gif');
    expect(() => fromSyndication(json('syn_text.json'), ref)).toThrow(expect.objectContaining({ code: 'no_media' }));
  });

  it('tombstones and empty answers', () => {
    expect(() => fromSyndication({ __typename: 'TweetTombstone' }, ref)).toThrow(expect.objectContaining({ code: 'restricted' }));
    expect(() => fromSyndication({}, ref)).toThrow(expect.objectContaining({ code: 'not_found' }));
  });

  it('FxTwitter gives the same items; its 404 and 401 map to not_found and private', () => {
    const p = fromFxTwitter(json('fx_video.json'), ref);
    expect(p.method).toBe('thirdparty');
    expect(p.items.map((i) => i.type)).toEqual(['video', 'video']);
    const bare = (u) => u.split('?')[0];
    expect(bare(p.items[0].variants[0].url)).toBe(bare(fromSyndication(json('syn_video.json'), ref).items[0].variants[0].url));
    expect(fromFxTwitter(json('fx_photos.json'), ref).items).toHaveLength(3);
    expect(() => fromFxTwitter(json('fx_missing.json'), ref)).toThrow(expect.objectContaining({ code: 'not_found' }));
    expect(() => fromFxTwitter({ code: 401 }, ref)).toThrow(expect.objectContaining({ code: 'private' }));
  });

  it('the syndication token and photo URL rules', () => {
    expect(syndicationToken('2115476295169814978')).toMatch(/^[0-9a-z]+$/);
    expect(photoVariants('https://pbs.twimg.com/media/HVFva4RXsAEO1pW.jpg').map((v) => v.url)).toEqual([
      'https://pbs.twimg.com/media/HVFva4RXsAEO1pW?format=jpg&name=orig',
      'https://pbs.twimg.com/media/HVFva4RXsAEO1pW?format=jpg&name=4096x4096',
      'https://pbs.twimg.com/media/HVFva4RXsAEO1pW?format=jpg&name=large',
    ]);
    expect(photoVariants('https://evil.com/media/a.jpg')).toEqual([]);
  });
});

describe('Pinterest and Snapchat responses (recorded from Serverless)', () => {
  it('an image pin → its original image first, then 564x; the pinner from profile_url', () => {
    const p = fromPinInfo(json('pin_image.json'), id('https://www.pinterest.com/pin/424605071146269969/').ref);
    expect(p.items).toHaveLength(1);
    expect(p.items[0].type).toBe('photo');
    expect(p.items[0].variants[0].url).toMatch(/^https:\/\/i\.pinimg\.com\/originals\//);
    expect(p.items[0].variants[1].url).toMatch(/\/564x\//);
    expect(p.author).toBe('@pinterest');
    expect(p.coverOnly).toBe(false);
    expect(p.title).toContain('it’s perfect'); // &#8217; decoded
    expect(p.title).not.toMatch(/&#\d+;|&amp;/);
    expect(() => fromPinInfo(json('pin_missing.json'), {})).toThrow(expect.objectContaining({ code: 'not_found' }));
  });

  it('a video pin → its MP4 (never the HLS playlist)', () => {
    const p = fromPinInfo(json('pin_video.json'), id('https://www.pinterest.com/pin/424605071146271645/').ref);
    expect(p.items).toHaveLength(1);
    expect(p.items[0]).toMatchObject({ type: 'video', width: 1280, height: 720, duration: 17 });
    expect(p.items[0].variants.map((v) => v.url)).toEqual(['https://v1.pinimg.com/videos/iht/expMp4/15/c6/ec/15c6ec2bc79627100c13c3bdc51b1b3a_720w.mp4']);
    expect(p.coverOnly).toBe(false);
  });

  it('an Idea Pin has no public video file: its cover image, marked cover-only', () => {
    const p = fromPinInfo(json('pin_story.json'), id('https://www.pinterest.com/pin/424605071146264256/').ref);
    expect(p.items[0].type).toBe('photo');
    expect(p.coverOnly).toBe(true);
  });

  it('a Spotlight page → its og:video MP4 and the creator', () => {
    const s = 'W7_EDlXWTBiXAEEniNoMPwAAYYm1kc21qZXdyAaGq_FkdAaGq_Af0AAAAAA';
    const p = fromSpotlightHtml(fixture('snap_spotlight.html'), id(`https://www.snapchat.com/spotlight/${s}`).ref);
    expect(p.items[0].type).toBe('video');
    expect(p.items[0].variants[0].url).toMatch(/^https:\/\/cf-st\.sc-cdn\.net\//);
    expect(p.items[0].variants[0].url).not.toContain('&amp;');
    expect(p.author).toBe('@emeriefjones2');
    expect(() => fromSpotlightHtml('<html><meta property="og:title" content="x"></html>', {})).toThrow(expect.objectContaining({ code: 'no_media' }));
    expect(() => fromSpotlightHtml('<meta property="og:video" content="https://evil.com/a.mp4">', {})).toThrow(expect.objectContaining({ code: 'no_media' }));
  });

  it('meta tags parse in any attribute order; Location headers resolve', () => {
    expect(metaTags('<meta content="https://a/b?x=1&amp;y=2" property="og:image"/><meta name="og:title" content=\'T &#x27;q&#x27;\'>')).toEqual({ 'og:image': 'https://a/b?x=1&y=2', 'og:title': "T 'q'" });
    expect(resolveLocation('https://pin.it/abc', '/pin/1/')).toBe('https://pin.it/pin/1/');
    expect(resolveLocation('https://pin.it/abc', 'https://www.pinterest.com/pin/1/')).toBe('https://www.pinterest.com/pin/1/');
  });
});

describe('capabilities are truthful', () => {
  it('built adapters: X supported, Pinterest and Snapchat limited, official APIs need approval; others unavailable', () => {
    expect(registry.statusOf('x')).toBe('SUPPORTED');
    expect(registry.statusOf('pinterest')).toBe('LIMITED');
    expect(registry.statusOf('snapchat')).toBe('LIMITED');
    for (const a of registry.ADAPTERS) expect(a.capabilities().methods.official).toBe('REQUIRES_APPROVAL');
    for (const s of registry.STUBS) expect(registry.statusOf(s.id)).toBe('UNAVAILABLE');
    expect(registry.ADAPTERS.length + registry.STUBS.length).toBe(14);
  });

  it('every method an adapter offers has a risk note in fa, en and ru', () => {
    for (const a of registry.ADAPTERS) {
      for (const m of a.methodOrder) {
        for (const l of LANGS) expect(String(a.riskNotes[m][l]).length, `${a.id} ${m} ${l}`).toBeGreaterThan(60);
      }
    }
  });

  it('adapters only allow https media hosts of their own platform', () => {
    expect(registry.byId('x').mediaHosts).toEqual(['pbs.twimg.com', 'video.twimg.com']);
    expect(registry.byId('pinterest').mediaHosts).toEqual(['i.pinimg.com', 'v1.pinimg.com']);
    expect(registry.byId('snapchat').headSafe).toBe(false); // HEAD to its CDN crashes the invocation (measured)
    expect(registry.byId('snapchat').mediaHosts).toEqual(['*.sc-cdn.net']);
    expect(parseUrl('https://cf-st.sc-cdn.net/d/x')).not.toBeNull();
  });
});

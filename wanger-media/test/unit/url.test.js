import { describe, expect, it } from 'vitest';
import { extractLinks, hostMatches, isAllowedFetch, isPublicHostname, parseUrl } from '../../tgcloud/lib/url.js';

describe('strict URL parsing', () => {
  it('accepts ordinary http(s) links and normalises the host', () => {
    expect(parseUrl('https://X.com/SpaceX/status/123?s=20#x')).toMatchObject({ scheme: 'https', host: 'x.com', path: '/SpaceX/status/123', query: 's=20', fragment: 'x' });
    expect(parseUrl('http://www.pinterest.com/pin/123/').host).toBe('www.pinterest.com');
    expect(parseUrl('https://x.com:443/a').href).toBe('https://x.com/a');
    expect(parseUrl('https://x.com').path).toBe('/');
  });

  it('refuses malicious and odd URLs', () => {
    const bad = [
      'javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'ftp://x.com/a', '//x.com/a', 'x.com/a',
      'http://127.0.0.1/', 'http://10.0.0.1/x', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/', 'http://[fe80::1]/',
      'http://localhost/', 'http://localhost:8080/', 'http://intranet.local/', 'http://router.lan/', 'http://foo.internal/',
      'http://2130706433/', 'http://0x7f000001/', 'http://user:pass@x.com/', 'https://x.com@evil.com/', 'https://x.com:8443/',
      'http://x.com:443/', 'https://exa mple.com/', 'https://x.com/\u0000', 'https://x.com/<script>', 'https://-x.com/',
      'https://singlelabel/', 'https://' + 'a'.repeat(2050) + '.com/', '', null, 42,
    ];
    for (const u of bad) expect(parseUrl(u), String(u).slice(0, 60)).toBeNull();
  });

  it('public hostnames only', () => {
    expect(isPublicHostname('video.twimg.com')).toBe(true);
    expect(isPublicHostname('xn--80ak6aa92e.com')).toBe(true);
    for (const h of ['127.0.0.1', '1.2.3.4', 'localhost', 'a.local', 'x', 'a.example', 'foo.test', 'a..b.com']) expect(isPublicHostname(h), h).toBe(false);
  });

  it('allowlists: exact hosts and *.domain patterns; https only', () => {
    expect(hostMatches('cf-st.sc-cdn.net', ['*.sc-cdn.net'])).toBe(true);
    expect(hostMatches('sc-cdn.net', ['*.sc-cdn.net'])).toBe(true);
    expect(hostMatches('evilsc-cdn.net', ['*.sc-cdn.net'])).toBe(false);
    expect(hostMatches('pbs.twimg.com.evil.com', ['pbs.twimg.com'])).toBe(false);
    expect(isAllowedFetch('https://pbs.twimg.com/media/a.jpg', ['pbs.twimg.com'])).toBe(true);
    expect(isAllowedFetch('http://pbs.twimg.com/media/a.jpg', ['pbs.twimg.com'])).toBe(false);
    expect(isAllowedFetch('https://evil.com/a.jpg', ['pbs.twimg.com'])).toBe(false);
  });
});

describe('links in messages', () => {
  const msg = (text, entities) => ({ text, entities });
  it('reads url and text_link entities in order, adds a missing scheme, dedupes, caps at 3', () => {
    const text = 'see x.com/a/status/1 and https://pin.it/abc and again x.com/a/status/1';
    const m = msg(text, [
      { type: 'url', offset: 4, length: 16 },
      { type: 'url', offset: 25, length: 18 },
      { type: 'url', offset: text.lastIndexOf('x.com'), length: 16 },
    ]);
    expect(extractLinks(m)).toEqual(['https://x.com/a/status/1', 'https://pin.it/abc']);
    const tl = msg('click here', [{ type: 'text_link', offset: 0, length: 5, url: 'https://www.snapchat.com/spotlight/AAAAAAAAAAAAAAAAAAAAAAAA' }]);
    expect(extractLinks(tl)).toEqual(['https://www.snapchat.com/spotlight/AAAAAAAAAAAAAAAAAAAAAAAA']);
    const many = msg('a b c d', [0, 2, 4, 6].map((o, i) => ({ type: 'text_link', offset: o, length: 1, url: `https://x.com/u/status/${i}` })));
    expect(extractLinks(many)).toHaveLength(3);
  });

  it('uses UTF-16 offsets (emoji and Persian before the link) and captions', () => {
    const text = '😀 سلام https://x.com/a/status/9';
    const m = { caption: text, caption_entities: [{ type: 'url', offset: text.indexOf('https'), length: 24 }] };
    expect(extractLinks(m)).toEqual(['https://x.com/a/status/9']);
  });

  it('plain text without entities has no links (Telegram marks every link it sees)', () => {
    expect(extractLinks({ text: 'hello' })).toEqual([]);
    expect(extractLinks(null)).toEqual([]);
  });
});

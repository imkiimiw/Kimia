// Phase 7 adapters: link identification and parsing of the responses recorded from Serverless
// (test/fixtures, 2026-11-06). Tests never call real platforms.
import { describe, expect, it } from 'vitest';
import { cleanText } from '../../tgcloud/lib/platforms/common.js';
import { extOf, fileKind } from '../../tgcloud/lib/platforms/discord.js';
import * as facebook from '../../tgcloud/lib/platforms/facebook.js';
import * as registry from '../../tgcloud/lib/platforms/index.js';
import { contextJson, fromEmbed } from '../../tgcloud/lib/platforms/instagram.js';
import * as reddit from '../../tgcloud/lib/platforms/reddit.js';
import * as soundcloud from '../../tgcloud/lib/platforms/soundcloud.js';
import * as spotify from '../../tgcloud/lib/platforms/spotify.js';
import * as threads from '../../tgcloud/lib/platforms/threads.js';
import * as tiktok from '../../tgcloud/lib/platforms/tiktok.js';
import * as twitch from '../../tgcloud/lib/platforms/twitch.js';
import * as youtube from '../../tgcloud/lib/platforms/youtube.js';
import { fixture } from '../helpers/web.js';

const id = (link) => registry.identify(link);
const ref = (link) => {
  const r = id(link);
  expect(r.kind, link).toBe('post');
  return r.ref;
};
const unsupported = (links) => { for (const l of links) expect(id(l).kind, l).toBe('unsupported_kind'); };
const json = (name) => JSON.parse(fixture(name));
const code = (fn) => { try { fn(); } catch (err) { return err.code; } return 'no error'; };

describe('identifying Phase 7 links', () => {
  it('YouTube: watch, youtu.be, shorts, live, embed — not channels or playlists', () => {
    for (const l of ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ', 'https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=10',
      'https://www.youtube.com/live/dQw4w9WgXcQ', 'https://www.youtube.com/embed/dQw4w9WgXcQ', 'https://music.youtube.com/watch?v=dQw4w9WgXcQ']) {
      expect(ref(l).key, l).toBe('youtube:dQw4w9WgXcQ');
    }
    expect(ref('https://www.youtube.com/shorts/dQw4w9WgXcQ').url).toBe('https://www.youtube.com/shorts/dQw4w9WgXcQ');
    unsupported(['https://www.youtube.com/@RickAstleyYT', 'https://www.youtube.com/playlist?list=PL1', 'https://www.youtube.com/watch?v=short', 'https://youtu.be/']);
  });

  it('SoundCloud: tracks, sets and on.soundcloud.com — not profiles or secret links', () => {
    expect(ref('https://soundcloud.com/forss/flickermood')).toMatchObject({ key: 'soundcloud:forss/flickermood', account: 'soundcloud:forss' });
    expect(ref('https://soundcloud.com/forss/sets/soulhack').key).toBe('soundcloud:forss/sets/soulhack');
    expect(ref('https://on.soundcloud.com/AbC123').short).toBe('AbC123');
    unsupported(['https://soundcloud.com/forss', 'https://soundcloud.com/discover/sets', 'https://soundcloud.com/forss/flickermood/s-AbCdEf', 'https://soundcloud.com/forss/likes']);
  });

  it('Reddit: comment links (any subdomain), share and redd.it short links — not media hosts', () => {
    for (const l of ['https://www.reddit.com/r/pics/comments/92dd8/test_post_please_ignore/', 'https://old.reddit.com/r/pics/comments/92dd8/', 'https://reddit.com/r/pics/comments/92dd8']) {
      expect(ref(l)).toMatchObject({ key: 'reddit:92dd8', url: 'https://www.reddit.com/r/pics/comments/92dd8/' });
    }
    expect(ref('https://www.reddit.com/comments/92dd8/').url).toBe('https://www.reddit.com/comments/92dd8/');
    expect(ref('https://www.reddit.com/r/pics/s/AbCd1234').short).toBe('AbCd1234');
    expect(ref('https://redd.it/92dd8').short).toBe('92dd8');
    unsupported(['https://www.reddit.com/r/pics/', 'https://i.redd.it/abc.jpg', 'https://v.redd.it/abc', 'https://www.reddit.com/user/qgyh2/']);
  });

  it('Spotify: tracks, albums, playlists, artists, episodes, shows (also intl/embed) and spotify.link', () => {
    expect(ref('https://open.spotify.com/track/11dFghVXANMlKmJXsNCbNl?si=abc')).toMatchObject({ key: 'spotify:track:11dFghVXANMlKmJXsNCbNl', url: 'https://open.spotify.com/track/11dFghVXANMlKmJXsNCbNl' });
    expect(ref('https://open.spotify.com/intl-de/album/0tGPJ0bkWOUmH7MEOR77qc').key).toBe('spotify:album:0tGPJ0bkWOUmH7MEOR77qc');
    expect(ref('https://open.spotify.com/embed/playlist/37i9dQZF1DXcBWIGoYBM5M').key).toBe('spotify:playlist:37i9dQZF1DXcBWIGoYBM5M');
    expect(ref('https://spotify.link/AbCd1234').short).toBe('AbCd1234');
    unsupported(['https://open.spotify.com/', 'https://open.spotify.com/track/short', 'https://open.spotify.com/user/someone']);
  });

  it('Twitch: video links only — clips and channels are refused', () => {
    expect(ref('https://www.twitch.tv/videos/6528877')).toMatchObject({ key: 'twitch:video:6528877', url: 'https://www.twitch.tv/videos/6528877' });
    unsupported(['https://www.twitch.tv/riotgames', 'https://clips.twitch.tv/FaintLightGullWholeWheat', 'https://www.twitch.tv/riotgames/clip/Abc', 'https://www.twitch.tv/directory']);
  });

  it('Facebook: videos, reels, watch, posts, permalinks, photos and short links — not pages or groups', () => {
    expect(ref('https://www.facebook.com/cnn/videos/10155529876156509/')).toMatchObject({ key: 'facebook:video:10155529876156509', account: 'facebook:cnn', url: 'https://www.facebook.com/watch/?v=10155529876156509' });
    expect(ref('https://www.facebook.com/cnn/videos/some-title/10155529876156509/').key).toBe('facebook:video:10155529876156509');
    expect(ref('https://m.facebook.com/watch/?v=10155529876156509').key).toBe('facebook:video:10155529876156509');
    expect(ref('https://www.facebook.com/reel/10155529876156509').key).toBe('facebook:video:10155529876156509');
    expect(ref('https://www.facebook.com/cnn/posts/pfbid02abcdefghijklmnop').key).toBe('facebook:post:pfbid02abcdefghijklmnop');
    expect(ref('https://www.facebook.com/permalink.php?story_fbid=123456789&id=987654321').key).toBe('facebook:post:123456789');
    expect(ref('https://fb.watch/AbCd12/').short).toBe('AbCd12');
    expect(ref('https://www.facebook.com/share/v/AbCd12/').short).toBe('AbCd12');
    unsupported(['https://www.facebook.com/facebook', 'https://www.facebook.com/groups/123/', 'https://www.facebook.com/watch/', 'https://www.facebook.com/login.php', 'https://www.facebook.com/events/1/']);
  });

  it('Threads: post links on threads.net and threads.com — not profiles', () => {
    expect(ref('https://www.threads.net/@zuck/post/CuP48CiS5sx')).toMatchObject({ key: 'threads:CuP48CiS5sx', account: 'threads:zuck', url: 'https://www.threads.com/@zuck/post/CuP48CiS5sx' });
    expect(ref('https://threads.com/t/CuP48CiS5sx').url).toBe('https://www.threads.com/t/CuP48CiS5sx');
    unsupported(['https://www.threads.com/@zuck', 'https://www.threads.com/search']);
  });

  it('TikTok: video and photo links, /v/, embeds and vm./vt./t short links — not profiles', () => {
    expect(ref('https://www.tiktok.com/@scout2015/video/6718335390845095173?lang=en')).toMatchObject({ key: 'tiktok:6718335390845095173', account: 'tiktok:scout2015' });
    expect(ref('https://www.tiktok.com/@scout2015/photo/7300000000000000000').url).toBe('https://www.tiktok.com/@scout2015/photo/7300000000000000000');
    expect(ref('https://m.tiktok.com/v/6718335390845095173.html').key).toBe('tiktok:6718335390845095173');
    expect(ref('https://www.tiktok.com/embed/v2/6718335390845095173').key).toBe('tiktok:6718335390845095173');
    expect(ref('https://vm.tiktok.com/ZMd5x6v9C/').short).toBe('ZMd5x6v9C');
    expect(ref('https://www.tiktok.com/t/ZTRabcdef/').short).toBe('ZTRabcdef');
    unsupported(['https://www.tiktok.com/@scout2015', 'https://www.tiktok.com/tag/cats', 'https://www.tiktok.com/@a/video/1']);
  });

  it('Instagram: posts, reels, tv, user-prefixed and embed links, /share/ links — not stories or profiles', () => {
    for (const l of ['https://www.instagram.com/p/fA9uwTtkSN/', 'https://instagram.com/p/fA9uwTtkSN', 'https://www.instagram.com/diegoquinteiro/p/fA9uwTtkSN/', 'https://www.instagram.com/p/fA9uwTtkSN/embed/captioned/', 'https://instagr.am/p/fA9uwTtkSN/']) {
      expect(ref(l).key, l).toBe('instagram:fA9uwTtkSN');
    }
    expect(ref('https://www.instagram.com/reel/Chunk8-jurw/?igsh=abc').url).toBe('https://www.instagram.com/reel/Chunk8-jurw/');
    expect(ref('https://www.instagram.com/reels/Chunk8-jurw/').url).toBe('https://www.instagram.com/reel/Chunk8-jurw/');
    expect(ref('https://www.instagram.com/share/reel/BAabc123/').short).toBe('BAabc123');
    unsupported(['https://www.instagram.com/instagram/', 'https://www.instagram.com/stories/instagram/123/', 'https://www.instagram.com/explore/', 'https://www.instagram.com/constructor/abc12/']);
  });

  it('Discord: attachment links on its CDN keep their signature — message, invite and avatar links are refused', () => {
    const l = 'https://cdn.discordapp.com/attachments/1100000000000000000/1200000000000000000/cat.png?ex=6a&is=6b&hm=abc123&';
    expect(ref(l)).toMatchObject({ key: 'discord:1200000000000000000', name: 'cat.png', url: l });
    expect(ref('https://media.discordapp.net/attachments/1100000000000000000/1200000000000000000/clip.mp4?ex=1').key).toBe('discord:1200000000000000000');
    unsupported(['https://discord.com/channels/1/2/3', 'https://discord.gg/abc', 'https://cdn.discordapp.com/avatars/1/abc.png', 'https://cdn.discordapp.com/embed/avatars/0.png', 'https://discordapp.com/channels/1/2']);
  });

  it('look-alike hosts are not the platform', () => {
    for (const l of ['https://youtube.com.evil.example.org/watch?v=dQw4w9WgXcQ', 'https://notinstagram.com/p/abc12/', 'https://cdn.discordapp.com.evil.org/attachments/1/2/a.png', 'https://evil-spotify.com/track/11dFghVXANMlKmJXsNCbNl']) {
      expect(['unknown', 'invalid']).toContain(id(l).kind);
    }
  });
});

describe('parsing recorded responses', () => {
  it('YouTube oEmbed → title, channel, account and thumbnail card', () => {
    const p = youtube.fromOembed(json('yt_oembed.json'), ref('https://youtu.be/dQw4w9WgXcQ'));
    expect(p).toMatchObject({
      platform: 'youtube', method: 'official', meta: true, items: [], title: 'Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)',
      author: 'Rick Astley', account: 'youtube:rickastleyyt', cover: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
    });
    expect(code(() => youtube.fromOembed({}, ref('https://youtu.be/dQw4w9WgXcQ')))).toBe('not_found');
  });

  it('SoundCloud oEmbed → the title without " by <artist>", the artist and the artwork', () => {
    const p = soundcloud.fromOembed(json('sc_oembed.json'), ref('https://soundcloud.com/forss/flickermood'));
    expect(p).toMatchObject({ title: 'Flickermood', author: 'Forss', cover: 'https://i1.sndcdn.com/artworks-000067273316-smsiqx-t500x500.jpg', meta: true });
  });

  it('Reddit oEmbed → title, u/author and r/community; no image (text card)', () => {
    const p = reddit.fromOembed(json('reddit_oembed.json'), ref('https://www.reddit.com/comments/92dd8/'));
    expect(p).toMatchObject({ title: 'test post please ignore', author: 'u/qgyh2', details: 'r/pics', account: 'reddit:qgyh2', cover: null });
  });

  it('Spotify page → title, "artist · album · song · year" and cover — never the audio preview', () => {
    const html = fixture('spotify_track.html');
    expect(html).toContain('og:audio'); // the preview is in the page…
    const p = spotify.fromPage(html, ref('https://open.spotify.com/track/11dFghVXANMlKmJXsNCbNl'));
    expect(p).toMatchObject({ title: 'Cut To The Feeling', details: 'Carly Rae Jepsen · Cut To The Feeling · Song · 2017', cover: 'https://i.scdn.co/image/ab67616d0000b2737359994525d219f64872d3b1', items: [] });
    expect(JSON.stringify(p)).not.toContain('p.scdn.co'); // …and is never used
    const album = spotify.fromPage('<meta property="og:title" content="Listen to Cut To The Feeling - Single by Carly Rae Jepsen | Spotify">', ref('https://open.spotify.com/album/0tGPJ0bkWOUmH7MEOR77qc'));
    expect(album.title).toBe('Cut To The Feeling - Single by Carly Rae Jepsen');
    expect(code(() => spotify.fromPage('<html></html>', ref('https://open.spotify.com/album/0tGPJ0bkWOUmH7MEOR77qc')))).toBe('not_found');
  });

  it('Twitch video page → title, channel and thumbnail; a channel or generic page is not a video', () => {
    const p = twitch.fromPage(fixture('twitch_video.html'), ref('https://www.twitch.tv/videos/6528877'));
    expect(p).toMatchObject({ title: 'LCK Summer Split - Week 6 Day 1', author: 'riotgames', account: 'twitch:riotgames' });
    expect(p.cover).toMatch(/^https:\/\/static-cdn\.jtvnw\.net\//);
    expect(code(() => twitch.fromPage(fixture('twitch_channel.html'), ref('https://www.twitch.tv/videos/6528877')))).toBe('not_found');
  });

  it('Facebook video page → the post text (not the localised view counts) and preview image; a login page is refused', () => {
    const r = ref('https://www.facebook.com/cnn/videos/10155529876156509/');
    const p = facebook.fromPage(fixture('facebook_video.html'), r, 'https://www.facebook.com/cnn/videos/10155529876156509/');
    expect(p.title).toMatch(/^She survived the holocaust/);
    expect(p.title).not.toMatch(/weergaven/);
    expect(p).toMatchObject({ author: 'cnn', account: 'facebook:cnn', meta: true });
    expect(p.cover).toMatch(/^https:\/\/scontent-[a-z0-9-]+\.xx\.fbcdn\.net\//);
    const login = '<meta property="og:title" content="Log in to Facebook"><meta property="og:url" content="https://www.facebook.com/login/">';
    expect(code(() => facebook.fromPage(login, r))).toBe('login_wall');
    expect(code(() => facebook.fromPage('<html></html>', r))).toBe('login_wall');
  });

  it('Threads post page → the text, "Name (@user)" and the preview image; a profile page is not a post', () => {
    const p = threads.fromPage(fixture('threads_post.html'), ref('https://www.threads.com/@zuck/post/CuP48CiS5sx'));
    expect(p).toMatchObject({ title: 'Let\'s do this. Welcome to Threads. 🔥', author: 'Mark Zuckerberg (@zuck)', account: 'threads:zuck' });
    expect(p.cover).toMatch(/^https:\/\/scontent-[a-z0-9-]+\.cdninstagram\.com\//);
    expect(code(() => threads.fromPage(fixture('threads_profile.html'), ref('https://www.threads.com/@zuck/post/CuP48CiS5sx')))).toBe('not_found');
  });

  it('TikTok page data → description, author and cover — never the video addresses', () => {
    const html = fixture('tiktok_page.html');
    expect(html).toContain('playAddr');
    const p = tiktok.fromPage(html, ref('https://www.tiktok.com/@scout2015/video/6718335390845095173'));
    expect(p).toMatchObject({ author: '@scout2015', account: 'tiktok:scout2015', url: 'https://www.tiktok.com/@scout2015/video/6718335390845095173', items: [] });
    expect(p.title).toMatch(/^Scramble up ur name/);
    expect(p.cover).toMatch(/^https:\/\/p16-common-sign\.tiktokcdn-eu\.com\//);
    expect(JSON.stringify(p)).not.toMatch(/playAddr|downloadAddr|video\/tos/);
    expect(code(() => tiktok.fromPage(fixture('tiktok_missing.html'), ref('https://www.tiktok.com/@ab/video/7000000000000000000')))).toBe('not_found');
    const priv = fixture('tiktok_page.html').replace('"privateItem":false', '"privateItem":true');
    expect(code(() => tiktok.fromPage(priv, ref('https://www.tiktok.com/@ab/video/7000000000000000000')))).toBe('private');
    expect(code(() => tiktok.fromPage('<html>captcha</html>', ref('https://www.tiktok.com/@ab/video/7000000000000000000')))).toBe('unavailable');
  });

  it('Instagram embed → a video post, a carousel of videos, a copyright-blocked reel (cover + note), a missing post', () => {
    const video = fromEmbed(fixture('ig_embed.html'), ref('https://www.instagram.com/p/fA9uwTtkSN/'));
    expect(video).toMatchObject({ platform: 'instagram', author: '@diegoquinteiro', account: 'instagram:diegoquinteiro', title: 'Wii Gato (Lipe Sleep)', coverOnly: false });
    expect(video.items).toHaveLength(1);
    expect(video.items[0]).toMatchObject({ type: 'video', width: 640, height: 640, duration: 15 });
    expect(video.items[0].variants[0].url).toMatch(/^https:\/\/scontent-ams2-1\.cdninstagram\.com\/o1\/v\/.+\.mp4\?/);

    const side = fromEmbed(fixture('ig_sidecar.html'), ref('https://www.instagram.com/p/BQ0eAlwhDrw/'));
    expect(side.items.map((i) => i.type)).toEqual(['video', 'video', 'video']);
    expect(side.author).toBe('@instagram');

    const reel = fromEmbed(fixture('ig_reel.html'), ref('https://www.instagram.com/reel/Chunk8-jurw/'));
    expect(reel.coverOnly).toBe(true);
    expect(reel.items).toHaveLength(1);
    expect(reel.items[0].type).toBe('photo');
    expect(reel.items[0].variants[0]).toMatchObject({ width: 1080, height: 1920 });
    expect(reel.items[0].variants.length).toBeLessThanOrEqual(3);

    expect(contextJson(fixture('ig_missing.html'))).toBeNull();
    expect(code(() => fromEmbed(fixture('ig_missing.html'), ref('https://www.instagram.com/p/AAAAAAAAAAA/')))).toBe('not_found');
  });

  it('Discord files: extension and Content-Type must both be an image, GIF or MP4, and agree', () => {
    expect(fileKind('cat.png', 'image/png')).toBe('photo');
    expect(fileKind('CAT.JPG', 'image/jpeg')).toBe('photo');
    expect(fileKind('a.gif', 'image/gif')).toBe('gif');
    expect(fileKind('clip.mp4', 'video/mp4; codecs=avc1')).toBe('video');
    for (const [name, type] of [['setup.exe', 'application/octet-stream'], ['a.png', 'text/html'], ['a.zip', 'application/zip'], ['a.mp4', 'image/png'], ['a.mov', 'video/quicktime'], ['png', 'image/png'], ['a.constructor', 'constructor']]) {
      expect(code(() => fileKind(name, type)), name).toBe('file_type');
    }
    expect(extOf('archive.tar.gz')).toBe('gz');
  });

  it('caption text from metadata: tags dropped, entities decoded, spaces tidied', () => {
    expect(cleanText('From the Soulhack album,&nbsp;recently <a href="x">featured</a>  here ')).toBe('From the Soulhack album, recently featured here');
  });
});

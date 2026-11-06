import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, MB } from '../../tgcloud/lib/config.js';
import x from '../../tgcloud/lib/platforms/x.js';
import { choose, domainCandidates, enabledMethods, limitsFrom, platformState, precheck } from '../../tgcloud/lib/policy.js';

const ok = {
  downloadsOn: true, exempt: false, user: { dl_day: '2026-11-06', dl_count: 0, last_dl_at: 0 }, today: '2026-11-06', now: 10_000,
  limits: limitsFrom(null), adapter: x, state: platformState({ methods: { public: true } }), blocked: false,
};

describe('policy precheck', () => {
  it('denies by default: nothing known → downloads_off; each missing fact denies', () => {
    expect(precheck(undefined)).toMatchObject({ ok: false, reason: 'downloads_off' });
    expect(precheck({})).toMatchObject({ ok: false, reason: 'downloads_off' });
    expect(precheck({ ...ok, adapter: null })).toMatchObject({ reason: 'not_built' });
    expect(precheck({ ...ok, state: null })).toMatchObject({ reason: 'platform_off' });
    expect(precheck({ ...ok, blocked: undefined })).toMatchObject({ reason: 'blocked' }); // blocklist not evaluated
  });

  it('allows when every check passes and returns the enabled methods in order', () => {
    expect(precheck(ok)).toEqual({ ok: true, methods: ['public'] });
    expect(precheck({ ...ok, state: platformState({ methods: { thirdparty: true, public: true } }) }).methods).toEqual(['public', 'thirdparty']);
  });

  it('checks run in the brief’s order', () => {
    const all = { ...ok, downloadsOn: false, user: { dl_day: ok.today, dl_count: 999, last_dl_at: ok.now }, state: platformState({}), blocked: true };
    expect(precheck(all).reason).toBe('downloads_off');
    expect(precheck({ ...all, downloadsOn: true }).reason).toBe('quota');
    expect(precheck({ ...all, downloadsOn: true, user: { ...all.user, dl_count: 0 } }).reason).toBe('cooldown');
    expect(precheck({ ...all, downloadsOn: true, user: { dl_count: 0, last_dl_at: 0 } }).reason).toBe('platform_off');
    expect(precheck({ ...all, downloadsOn: true, user: {}, state: platformState({ methods: { public: true }, paused: true }) }).reason).toBe('platform_paused');
    expect(precheck({ ...all, downloadsOn: true, user: {} , state: ok.state }).reason).toBe('blocked');
  });

  it('quota counts today only; cooldown reports the wait; staff are exempt', () => {
    const lim = { ...ok.limits, quota_per_day: 2, cooldown_s: 15 };
    expect(precheck({ ...ok, limits: lim, user: { dl_day: ok.today, dl_count: 2 } })).toMatchObject({ reason: 'quota', quota: 2 });
    expect(precheck({ ...ok, limits: lim, user: { dl_day: '2026-11-05', dl_count: 2 } }).ok).toBe(true);
    expect(precheck({ ...ok, limits: lim, user: { last_dl_at: ok.now - 5 } })).toMatchObject({ reason: 'cooldown', wait: 10 });
    expect(precheck({ ...ok, exempt: true, limits: lim, user: { dl_day: ok.today, dl_count: 99, last_dl_at: ok.now } }).ok).toBe(true);
    expect(precheck({ ...ok, limits: { ...lim, quota_per_day: 0 } }).reason).toBe('quota');
  });

  it('platform settings: every method off unless exactly true', () => {
    expect(platformState(undefined)).toEqual({ paused: false, methods: {} });
    expect(platformState({ methods: { public: 'yes', thirdparty: 1, official: true } }).methods).toEqual({ public: false, thirdparty: false, official: true });
    expect(enabledMethods(x, platformState({ methods: { official: true } }))).toEqual([]); // X has no official method built
  });

  it('limits are clamped to what Telegram allows', () => {
    expect(limitsFrom(null)).toEqual(DEFAULT_LIMITS);
    expect(limitsFrom({ max_mb: 500, quota_per_day: -1, cooldown_s: 'x' })).toEqual({ ...DEFAULT_LIMITS, max_mb: DEFAULT_LIMITS.max_mb });
    expect(limitsFrom({ max_mb: 20, quota_per_day: 5, cooldown_s: 0 })).toEqual({ max_mb: 20, quota_per_day: 5, cooldown_s: 0 });
  });

  it('domain candidates cover parents', () => {
    expect(domainCandidates('a.b.example.com')).toEqual(['a.b.example.com', 'b.example.com', 'example.com']);
  });
});

describe('size limits (choose)', () => {
  const vid = (...sizes) => ({ type: 'video', variants: sizes.map((b, i) => ({ url: `https://video.twimg.com/v${i}.mp4`, bytes: b })) });
  const max = 50 * MB;

  it('auto: the best that Telegram can fetch by URL (≤ 20 MB), else the best that can be uploaded', () => {
    expect(choose(vid(140 * MB, 41 * MB, 9 * MB, 3 * MB), 'auto', max)).toMatchObject({ via: 'url', variant: { bytes: 9 * MB }, downgraded: true });
    expect(choose(vid(41 * MB, 30 * MB), 'auto', max)).toMatchObject({ via: 'upload', variant: { bytes: 41 * MB }, downgraded: false });
    expect(choose(vid(19 * MB, 5 * MB), 'auto', max)).toMatchObject({ via: 'url', variant: { bytes: 19 * MB }, downgraded: false });
  });

  it('best: the best that can be uploaded; small: the smallest', () => {
    expect(choose(vid(140 * MB, 41 * MB, 9 * MB), 'best', max)).toMatchObject({ via: 'upload', variant: { bytes: 41 * MB }, downgraded: true });
    expect(choose(vid(41 * MB, 9 * MB, 3 * MB), 'small', max)).toMatchObject({ via: 'url', variant: { bytes: 3 * MB }, downgraded: false });
  });

  it('too big → error with the smallest size; the owner’s max_mb lowers the limit', () => {
    expect(choose(vid(140 * MB, 60 * MB), 'auto', max)).toEqual({ error: 'too_big', bytes: 60 * MB, max });
    expect(choose(vid(41 * MB), 'best', 30 * MB)).toEqual({ error: 'too_big', bytes: 41 * MB, max: 30 * MB });
    expect(choose(vid(19 * MB, 2 * MB), 'auto', 1 * MB)).toEqual({ error: 'too_big', bytes: 2 * MB, max: 1 * MB }); // also by URL
    expect(choose(vid(19 * MB, 2 * MB), 'auto', 10 * MB)).toMatchObject({ via: 'url', variant: { bytes: 2 * MB } });
  });

  it('photos: 5 MB by URL, 10 MB upload', () => {
    const ph = (...sizes) => ({ type: 'photo', variants: sizes.map((b) => ({ url: 'https://pbs.twimg.com/a', bytes: b })) });
    expect(choose(ph(4 * MB), 'auto', max)).toMatchObject({ via: 'url' });
    expect(choose(ph(7 * MB), 'auto', max)).toMatchObject({ via: 'upload' });
    expect(choose(ph(12 * MB, 2 * MB), 'best', max)).toMatchObject({ via: 'url', variant: { bytes: 2 * MB }, downgraded: true });
  });

  it('unknown size: only by URL (Telegram enforces its own limit), never downloaded by the bot', () => {
    expect(choose({ type: 'video', variants: [{ url: 'u1' }, { url: 'u2' }] }, 'auto', max)).toMatchObject({ via: 'url', variant: { url: 'u1' }, sizeUnknown: true });
    expect(choose({ type: 'video', variants: [] }, 'auto', max)).toEqual({ error: 'no_variant' });
  });
});

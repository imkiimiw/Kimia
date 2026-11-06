// The reference large-file relay (external-service/): its pure checks. The server itself needs a
// local Bot API server and is not run here.
import { describe, expect, it } from 'vitest';
import { allowedHost, authorized, MB, nextUrl, sendCall, validateRelay } from '../../external-service/lib.mjs';

const ok = {
  request_id: '1001:42', url: 'https://cdn.discordapp.com/attachments/1/2/a.mp4?ex=1', allow_hosts: ['cdn.discordapp.com', 'media.discordapp.net'],
  bytes: 300 * MB, type: 'video', chat_id: 1001, reply_to_message_id: 42, caption: '<b>x</b>', fail_text: 'failed',
};

describe('relay service checks', () => {
  it('accepts a well-formed job and keeps only what it needs', () => {
    expect(validateRelay(ok, 2000 * MB).job).toEqual({
      id: '1001:42', url: ok.url, allow: ok.allow_hosts, bytes: 300 * MB, type: 'video', chatId: 1001, replyTo: 42, caption: '<b>x</b>', failText: 'failed',
    });
  });

  it('refuses hosts off the allowlist, private hosts, other types, oversize and malformed jobs', () => {
    const v = (patch, max = 2000 * MB) => validateRelay({ ...ok, ...patch }, max).code;
    expect(v({ url: 'https://evil.example.org/a.mp4' })).toBe('UNSUPPORTED');
    expect(v({ url: 'http://cdn.discordapp.com/a.mp4' })).toBe('UNSUPPORTED');
    expect(v({ url: 'https://127.0.0.1/a.mp4', allow_hosts: ['127.0.0.1'] })).toBe('UNSUPPORTED');
    expect(v({ allow_hosts: [] })).toBe('UNSUPPORTED');
    expect(v({ type: 'document' })).toBe('UNSUPPORTED');
    expect(v({ bytes: 0 })).toBe('ERROR');
    expect(v({}, 100 * MB)).toBe('TOO_LARGE');
    expect(v({ chat_id: 'x' })).toBe('ERROR');
    expect(validateRelay(null, MB).code).toBe('ERROR');
  });

  it('allowlist matching like the bot: exact hosts and *.domain, https and port 443 only', () => {
    expect(allowedHost('https://scontent-ams2-1.cdninstagram.com/v/x.mp4', ['*.cdninstagram.com'])).toBe('scontent-ams2-1.cdninstagram.com');
    expect(allowedHost('https://cdninstagram.com.evil.net/x', ['*.cdninstagram.com'])).toBeNull();
    expect(allowedHost('https://user@cdn.discordapp.com/x', ['cdn.discordapp.com'])).toBeNull();
    expect(allowedHost('https://cdn.discordapp.com:8443/x', ['cdn.discordapp.com'])).toBeNull();
  });

  it('constant-time bearer check; local-file Bot API calls; relative redirects', () => {
    expect(authorized('Bearer abcdefghijklmnop', 'abcdefghijklmnop')).toBe(true);
    expect(authorized('Bearer abcdefghijklmnoq', 'abcdefghijklmnop')).toBe(false);
    expect(authorized('abcdefghijklmnop', 'abcdefghijklmnop')).toBe(false);
    expect(authorized('Bearer x', '')).toBe(false);
    const call = sendCall(validateRelay(ok, 2000 * MB).job, '/data/work/a.bin');
    expect(call).toEqual({ method: 'sendVideo', params: { chat_id: 1001, video: 'file:///data/work/a.bin', caption: '<b>x</b>', parse_mode: 'HTML', supports_streaming: true, reply_parameters: { message_id: 42, allow_sending_without_reply: true } } });
    expect(sendCall({ ...validateRelay(ok, 2000 * MB).job, type: 'gif', caption: '', replyTo: null }, '/p').params).toEqual({ chat_id: 1001, animation: 'file:///p' });
    expect(nextUrl('https://a.com/x/y', '/z')).toBe('https://a.com/z');
    expect(nextUrl('https://a.com/x/y', 'z')).toBe('https://a.com/x/z');
  });
});

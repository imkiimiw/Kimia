// The runtime is a bare V8 isolate (no TextEncoder), so UTF-8 is done by hand.

/** Byte length of a string in UTF-8, e.g. for Telegram's 64-byte callback_data limit. */
export function utf8Length(str) {
  let n = 0;
  for (const ch of String(str)) {
    const c = ch.codePointAt(0);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

/** UTF-8 bytes of a string (lone surrogates become U+FFFD, like TextEncoder). */
export function utf8Bytes(str) {
  const out = [];
  for (const ch of String(str)) {
    let c = ch.codePointAt(0);
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

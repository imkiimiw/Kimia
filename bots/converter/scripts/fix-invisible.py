# Rewrites invisible format characters (ZWNJ, bidi controls, ...) in source files as \uXXXX escapes.
# Usage: python3 scripts/fix-invisible.py  (from bots/converter/) — the test suite requires it.
import glob, unicodedata
for f in glob.glob('tgcloud/**/*.js', recursive=True) + glob.glob('tests/**/*.mjs', recursive=True):
    if '/vendor/' in f:
        continue
    s = open(f, encoding='utf-8').read()
    def bad(i, c):
        cat = unicodedata.category(c)
        if cat in ('Cf', 'Cn', 'Co', 'Cs', 'Me'):
            return True
        # a combining mark is fine after a letter or an emoji (Persian diacritics, VS16), not in a regex range
        return cat == 'Mn' and i > 0 and unicodedata.category(s[i - 1])[0] not in ('L', 'S', 'M')
    def esc(c):
        return '\\u%04x' % ord(c) if ord(c) < 0x10000 else '\\u{%x}' % ord(c)
    out = ''.join(esc(c) if bad(i, c) else c for i, c in enumerate(s))
    if out != s:
        open(f, 'w', encoding='utf-8').write(out)
        print('escaped', f)

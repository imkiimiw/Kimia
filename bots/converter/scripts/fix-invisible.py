# Rewrites invisible format characters (ZWNJ, bidi controls, ...) in source files as \uXXXX escapes.
# Usage: python3 scripts/fix-invisible.py  (from bots/converter/) — the test suite requires it.
import glob, unicodedata
for f in glob.glob('tgcloud/**/*.js', recursive=True) + glob.glob('tests/**/*.mjs', recursive=True):
    if '/vendor/' in f:
        continue
    s = open(f, encoding='utf-8').read()
    out = ''.join('\\u%04x' % ord(c) if unicodedata.category(c) == 'Cf' else c for c in s)
    if out != s:
        open(f, 'w', encoding='utf-8').write(out)
        print('escaped', f)

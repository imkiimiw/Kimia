// Project rules that are easy to break and expensive to discover on the platform.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../../tgcloud/', import.meta.url);
const files = readdirSync(root, { recursive: true }).map(String).filter((f) => f.endsWith('.js')).sort();
const source = (f) => readFileSync(new URL(f, root), 'utf8');
const importsOf = (src) => [...src.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);

/** Modules that must stay pure (no platform SDK), so their logic is testable and reusable. */
const PURE = ['lib/config.js', 'lib/util.js', 'lib/roles.js', 'lib/codec.js', 'lib/ui.js', 'lib/url.js', 'lib/policy.js', 'lib/i18n/index.js', 'lib/i18n/fa.js', 'lib/i18n/en.js', 'lib/i18n/ru.js'];

describe('module rules', () => {
  it('stays within the module budget (≤ 90; a 104-module deploy was refused)', () => {
    expect(files.length).toBeLessThanOrEqual(90);
  });

  it('handlers and endpoints are flat; handler names are Telegram update types in use', () => {
    const handlers = files.filter((f) => f.startsWith('handlers/'));
    for (const f of handlers) expect(f.split('/').length, f).toBe(2);
    expect(handlers).toEqual(['handlers/callback_query.js', 'handlers/message.js', 'handlers/my_chat_member.js']);
  });

  it('imports: the SDK by name, project modules by relative path with .js, never outside tgcloud/', () => {
    for (const f of files) {
      for (const spec of importsOf(source(f))) {
        if (spec === 'sdk' || spec.startsWith('sdk/')) {
          expect(['sdk', 'sdk/db', 'sdk/api', 'sdk/fetch'], `${f}: ${spec}`).toContain(spec);
          continue;
        }
        expect(spec.startsWith('./') || spec.startsWith('../'), `${f}: ${spec} must be relative`).toBe(true);
        expect(spec.endsWith('.js'), `${f}: ${spec} must end in .js`).toBe(true);
        const depth = f.split('/').length - 1;
        const ups = spec.split('/').filter((p) => p === '..').length;
        expect(ups <= depth, `${f}: ${spec} leaves tgcloud/`).toBe(true);
      }
    }
  });

  it('pure modules never import the SDK', () => {
    for (const f of PURE) expect(importsOf(source(f)).filter((s) => s.startsWith('sdk')), f).toEqual([]);
  });

  it('SQL lives in lib/db/ only (and the schema)', () => {
    for (const f of files.filter((x) => !x.startsWith('lib/db/') && x !== 'schema.js')) {
      expect(/\b(db\.(run|all|get|values)|from 'sdk\/db')/.test(source(f)), f).toBe(false);
    }
  });

  it('no secrets or tokens in the deployed code', () => {
    for (const f of files) {
      const src = source(f);
      expect(/\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/.test(src), `${f}: looks like a bot token`).toBe(false);
      expect(/\bapp\d+:[A-Za-z0-9_-]{16,}/.test(src), `${f}: looks like a CLI token`).toBe(false);
    }
  });

  it('no timers, URL or Node globals that the isolate lacks', () => {
    for (const f of files) {
      const src = source(f).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const g of ['setTimeout', 'setInterval', 'new URL(', 'URLSearchParams', 'Buffer.', 'process.', 'atob(', 'btoa(', 'AbortController', 'structuredClone']) {
        expect(src.includes(g), `${f} uses ${g}`).toBe(false);
      }
    }
  });
});

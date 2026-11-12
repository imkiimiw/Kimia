// Common user screens: language choice, welcome + main menu, help & settings, account, delete my
// data. Texts only from i18n; buttons only for features whose flag is on (brief §1 rule 7).
import { btn, markup, urlBtn } from '../core/codec.js';
import { esc } from '../core/html.js';
import { dayKey } from '../core/util.js';
import { users } from '../db/users.js';
import { packs as pdb, ops as opsDb } from '../db/packs.js';
import { system } from '../db/system.js';
import { transfer as tdb } from '../db/transfer.js';
import { QUOTA_FEATURES, APP_URL } from '../config.js';

/** First start / change: Persian and English, the suggested one marked. */
export function langView(app, suggested) {
  const mark = (l) => (l === suggested ? '✓ ' : '');
  return {
    text: `${app.t('lang.prompt')}\n\n<i>Choose your language.</i>`,
    keyboard: markup([[btn(`${mark('fa')}فارسی`, 'l', 'set', 'fa'), btn(`${mark('en')}English`, 'l', 'set', 'en')]]),
  };
}

/** Main menu keyboard (Studio buttons appear in Phase 2+ when their flags are on). */
export function menuKeyboard(app) {
  const rows = [];
  const web = (key, mode) => ({ text: app.tp(key), web_app: { url: `${APP_URL}?mode=${mode}` } });
  if (app.flag('studio')) rows.push([web('menu.studio', 'sticker')]);
  if (app.flag('gif_studio')) rows.push([web('menu.gif', 'gif')]);
  if (app.flag('packs')) rows.push([btn(app.tp('menu.packs'), 'm', 'packs', 0)]);
  if (app.flag('convert')) rows.push([web('menu.convert', 'convert')]);
  rows.push([btn(app.tp('menu.account'), 'm', 'acct'), btn(app.tp('menu.help'), 'm', 'help')]);
  if (app.can('panel.open')) rows.push([btn(app.tp('menu.admin'), 'a', 'home')]);
  return markup(rows);
}

export function menuView(app) {
  const custom = String(app.settings.get(`text.start.${app.lang}`) || '').trim();
  const text = custom ? esc(custom) : app.t('menu.welcome', { name: (app.user && app.user.first_name) || '' });
  return { text, keyboard: menuKeyboard(app) };
}

export function helpView(app) {
  const custom = String(app.settings.get(`text.help.${app.lang}`) || '').trim();
  return {
    text: custom ? esc(custom) : app.t('help.text'),
    keyboard: markup([
      [btn(app.tp('help.btn_lang'), 'm', 'lang')],
      [btn(app.tp('help.btn_delete'), 'dm', 'ask')],
      [btn(app.tp('common.menu'), 'm', 'home')],
    ]),
  };
}

export async function accountView(app) {
  const u = app.user;
  const acc = await app.account.getAccount(u.tg_id);
  const { quotas } = await app.account.getEntitlements(u.tg_id);
  const used = Object.fromEntries((await users.usageAll(u.tg_id, dayKey(app.clock.now()))).map((r) => [r.feature, r.count]));
  const lines = QUOTA_FEATURES.map((f) => app.t('acct.quota_line', {
    feature: app.tp(`feature.${f}`),
    used: used[f] || 0,
    limit: quotas[f] === Infinity ? app.tp('acct.unlimited') : quotas[f],
  })).join('\n');
  const packCount = await pdb.countByUser(u.tg_id);
  return {
    text: app.t('acct.text', {
      plan: app.tp(acc.plan === 'pro' ? 'acct.plan_pro' : 'acct.plan_free'),
      points: acc.points,
      packs: packCount,
      lang: app.tp(`lang.name.${app.lang}`),
      quotas: { __html: lines },
    }),
    keyboard: markup([[btn(app.tp('help.btn_lang'), 'm', 'lang')], [btn(app.tp('common.menu'), 'm', 'home')]]),
  };
}

export function deleteAskView(app) {
  return {
    text: app.t('dm.ask'),
    keyboard: markup([[btn(app.tp('dm.btn_yes'), 'dm', 'yes'), btn(app.tp('common.cancel'), 'dm', 'no')]]),
  };
}

/** /deletemydata: our records go; Telegram sticker sets stay (the user deletes them in "My packs"). */
export async function deleteMyData(app) {
  const id = app.user.tg_id;
  await app.publish.takeBackAll(id);
  await opsDb.cancelOfUser(id, app.clock.now());
  for (const packId of await pdb.idsByUser(id)) await pdb.remove(packId);
  await opsDb.deleteOfUser(id);
  await tdb.deleteOfUser(id);
  await users.deleteUsage(id);
  await system.clearState(id);
  await system.clearPending(id);
  await users.anonymize(id);
  app.stats.count('user.deleted_data');
}

/** The pack link button used by several screens. */
export const shareButton = (app, name) => urlBtn(app.tp('pk.btn_open_tg'), `https://t.me/addstickers/${name}`);

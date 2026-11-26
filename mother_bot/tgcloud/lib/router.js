// Entry point for every update. Order of checks for a private message:
//   1. record the user (and a referral, start=r_<id>); 2. a ban on the mother ('*' or 'mother') stops here;
//   3. anti-spam (team exempt); 4. commands; 5. the user's current step (a report, a reply, a panel
//   form); 6. anything else is a question for the assistant. Then the due work runs (lib/due.js).
// Group messages: only the owner's /setlog. Channel posts: the hub (lib/hub.js). Polls: the bot's own
// wakes (lib/wake.js).
//
// callback_data (ASCII, ≤ 64 bytes; every id is re-checked against the user):
//   user:  m main · ask · b catalog · bn newest · al all · bc:<cat> · b:<bot> page · bf:<bot> guide ·
//          bq:<bot> faq · ns:<bot> news toggle on a page · n news · nn:<bot|*> toggle in list · nk kinds ·
//          nkt:<bit> · st status · stw:<bot> tell me when it works · r report · r:<bot|_> · rok:<id> /
//          rno:<id> solved / not solved · tl tickets · t:<id> · tr:<id> reply · tk:<id> solved ·
//          c club · cj join · cl leave · cc:<campaign> claim · cm my codes · cr invite link · p profile ·
//          ua report a user · qt send the last question to the team
//   team:  a… (lib/admin.js adminCallback1, lib/admin2.js adminCallback2)
import { OWNER_ID } from './config.js';
import { adminCallback1, adminText1, panelHome } from './admin.js';
import { adminCallback2, adminText2, aiKeyCommand, userIdFrom } from './admin2.js';
import { answerQuestion } from './assistant.js';
import { recordView } from './activity.js';
import { ensureSeeded, getBot } from './catalog.js';
import {
  claimCode, creditReferral, joinClub, leaveClub,
} from './club.js';
import { afterUpdate } from './due.js';
import { onHubPost } from './hub.js';
import { openIncidentOf, watch } from './incidents.js';
import {
  allBotsView, askPrompt, botCard, botsHome, categoryView, clubView, faqView, featuresView, helpView, kindsView, mainMenu,
  myCodesView, newestView, newsView, profileView, reportPick, reportPrompt, statusBoard, ticketView, ticketsView,
} from './menu.js';
import { spamCheck } from './moderation.js';
import { toggleKind, toggleSub } from './news.js';
import {
  closeTicket, escalate, getTicket, overLimit, submitAbuse, submitQuestion, submitReport, userReply,
} from './reports.js';
import {
  activeBan, clearState, getUser, isOwner, isTeam, kvGet, markBlocked, setKv, setState, stateOf, touchUser,
} from './store.js';
import {
  answer, btn, call, createCtx, describeError, send, show,
} from './tg.js';
import { esc, fa, formatDate, truncate } from './util.js';
import { isOurWake } from './wake.js';

let seededChecked = false;
async function seedOnce() {
  if (seededChecked) return;
  await ensureSeeded();
  seededChecked = true;
}

async function myUsername(ctx) {
  const cached = await kvGet('bot_username');
  if (cached) return cached;
  try {
    const me = await call(ctx, 'getMe', {}, 'getMe');
    await setKv('bot_id', me.id);
    await setKv('bot_username', me.username);
    return me.username;
  } catch {
    return null;
  }
}

const result = (ctx, extra = {}) => ({ trace: ctx.trace, ...(ctx.due && Object.keys(ctx.due).length ? { due: ctx.due } : {}), ...extra });

async function banNotice(ctx, ban) {
  const until = Number(ban.until) ? `تا ${formatDate(ban.until, true)}` : 'به‌طور دائم';
  await send(ctx, 'banned', `⛔️ دسترسی شما به ربات‌های Wanger ${until} محدود شده است.${ban.reason ? `\nدلیل: ${esc(ban.reason)}` : ''}`);
}

// ---------- screens shared by commands and buttons ----------

async function openBot(ctx, user, key) {
  const v = await botCard(user, key);
  if (!v) return answer(ctx, 'این ربات پیدا نشد.', { alert: true });
  await recordView(user.user_id, v.bot.key);
  return show(ctx, 'bot_card', v.text, v.kb);
}

async function startReport(ctx, user, key) {
  if (await overLimit(user)) return show(ctx, 'report_limit', '⏳ امروز به سقف گزارش رسیده‌ای؛ فردا دوباره امتحان کن. اگر فوری است، پیامت را در گزارش‌های قبلی بنویس.', [[btn('🎫 گزارش‌های من', 'tl'), btn('🏠 منو', 'm')]]);
  const bot = key && key !== '_' ? await getBot(key) : null;
  await setState(user.user_id, 'report', { bot: bot ? bot.key : null });
  const v = await reportPrompt(bot);
  return show(ctx, 'report_prompt', v.text, v.kb);
}

async function watchBot(ctx, user, key) {
  const bot = await getBot(key);
  if (!bot) return answer(ctx);
  const inc = await openIncidentOf(bot.key);
  if (inc) await watch('inc', inc.id, user.user_id);
  else if (bot.mode === 'closed' || (bot.status && bot.status !== 'ok')) await watch('bot', bot.key, user.user_id);
  else return answer(ctx, `${bot.name} الان مشکلی ندارد ✅`, { alert: true });
  return answer(ctx, `🔔 باشه؛ وقتی ${bot.name} درست شد همین‌جا خبرت می‌کنم.`, { alert: true });
}

// ---------- commands ----------

const COMMANDS = [
  ['start', 'منوی اصلی'], ['bots', 'ربات‌های Wanger'], ['status', 'وضعیت ربات‌ها'], ['report', 'گزارش خطا'],
  ['news', 'اطلاع‌رسانی‌ها'], ['club', 'باشگاه مشتریان'], ['profile', 'پروفایل و تاریخچه'], ['help', 'راهنما'],
];

/** /setup (owner): the command menu and the bot's descriptions. */
async function setupBot(ctx) {
  const done = [];
  const tryCall = async (method, params, label) => {
    try {
      await call(ctx, method, params, 'setup');
      done.push(`✅ ${label}`);
    } catch (err) {
      done.push(`⚠️ ${label}: ${esc(describeError(err))}`);
    }
  };
  await tryCall('setMyCommands', { commands: COMMANDS.map(([command, description]) => ({ command, description })) }, 'منوی دستورها');
  await tryCall('setMyCommands', { commands: [...COMMANDS, ['admin', 'پنل مدیریت']].map(([command, description]) => ({ command, description })), scope: { type: 'chat', chat_id: OWNER_ID } }, 'منوی مالک');
  await tryCall('setMyShortDescription', { short_description: 'همه‌ی ربات‌های Wanger در یک‌جا: راهنما، وضعیت، گزارش خطا، خبرها و باشگاه مشتریان' }, 'توضیح کوتاه');
  await tryCall('setMyDescription', { description: 'ربات مادر Wanger همه‌ی ربات‌های Wanger را می‌شناسد. بنویس چه می‌خواهی تا ربات مناسب و طرز استفاده‌اش را بگویم؛ وضعیت ربات‌ها را ببین، خطا گزارش بده، خبر ربات‌های دلخواهت را بگیر و در باشگاه مشتریان کد تخفیف بگیر.' }, 'توضیح');
  await send(ctx, 'setup', `⚙️ <b>تنظیمات ربات</b>\n\n${done.join('\n')}`);
}

async function onStart(ctx, user, param, isNew) {
  await clearState(user.user_id);
  if (param && /^r_\d{5,15}$/.test(param) && isNew) await creditReferral(user, Number(param.slice(2)));
  if (param && /^b_[a-z0-9_]{2,16}$/.test(param)) return openBot(ctx, user, param.slice(2));
  if (param && /^report_[a-z0-9_]{2,16}$/.test(param)) return startReport(ctx, user, param.slice(7));
  if (param === 'club' || param === 'news') {
    const r = param === 'club' ? await clubView(user) : await newsView(user);
    return show(ctx, param, r.text, r.kb);
  }
  const v = await mainMenu(user);
  return show(ctx, 'main', v.text, v.kb);
}

async function onCommand(ctx, user, msg, cmd, arg, isNew) {
  const v = async (view, p) => {
    const r = await p;
    return show(ctx, view, r.text, r.kb);
  };
  switch (cmd) {
    case 'start':
      await onStart(ctx, user, arg, isNew);
      return true;
    case 'help':
      await v('help', helpView());
      return true;
    case 'menu':
    case 'cancel':
      await clearState(user.user_id);
      await v('main', mainMenu(user));
      return true;
    case 'bots':
      await v('bots', botsHome(user));
      return true;
    case 'status':
      await v('status', statusBoard(user));
      return true;
    case 'report':
      if (arg) await startReport(ctx, user, arg.toLowerCase());
      else await v('report_pick', reportPick(user));
      return true;
    case 'news':
      await v('news', newsView(user));
      return true;
    case 'club':
      await v('club', clubView(user));
      return true;
    case 'profile':
    case 'me':
      await v('profile', profileView(user));
      return true;
    case 'admin':
    case 'panel':
      if (!isTeam(user)) return false;
      await panelHome(ctx, user);
      return true;
    case 'aikey':
      if (!isOwner(user.user_id)) return false;
      await aiKeyCommand(ctx, msg, arg);
      return true;
    case 'setup':
      if (!isOwner(user.user_id)) return false;
      await setupBot(ctx);
      return true;
    default:
      return false;
  }
}

// ---------- steps ----------

async function onStep(ctx, user, st, msg) {
  const text = String(msg.text || '').trim();
  switch (st.name) {
    case 'report': {
      if (!text && !msg.caption && !msg.photo && !msg.document) {
        await send(ctx, 'report_need_text', 'لطفاً مشکل را با متن (یا اسکرین‌شات با توضیح) بفرست.');
        return true;
      }
      await clearState(user.user_id);
      const r = await submitReport(ctx, user, st.data.bot, msg);
      await send(ctx, 'report_answer', r.text, r.kb);
      return true;
    }
    case 'ticket_reply': {
      await clearState(user.user_id);
      const ok = await userReply(ctx, user, st.data.tid, msg);
      await send(ctx, 'ticket_reply_ok', ok ? '✅ پیامت برای تیم فرستاده شد.' : 'این گزارش پیدا نشد.', [[btn('🏠 منو', 'm')]]);
      return true;
    }
    case 'abuse_who': {
      const uid = await userIdFrom(msg);
      if (!uid) {
        const hidden = msg.forward_origin && msg.forward_origin.type === 'hidden_user';
        await send(ctx, 'abuse_who_bad', hidden
          ? '⚠️ این کاربر فوروارد پیام‌هایش را بسته و آیدی‌اش معلوم نیست. اگر آیدی عددی یا یوزرنیمش را داری بفرست، وگرنه توضیح بده چه کسی و در کدام ربات.'
          : '⚠️ کاربر را پیدا نکردم. پیامی از او فوروارد کن یا آیدی عددی‌اش را بفرست.');
        if (hidden) await setState(user.user_id, 'abuse_text', { target: 0 });
        return true;
      }
      if (uid === user.user_id) {
        await send(ctx, 'abuse_self', '🙂 خودت را نمی‌شود گزارش کرد.');
        return true;
      }
      await setState(user.user_id, 'abuse_text', { target: uid });
      await send(ctx, 'abuse_text', 'در کدام ربات و چه کار کرده؟ (اسپم، مزاحمت، اختلال…) در یک پیام توضیح بده؛ اسکرین‌شات هم می‌توانی بفرستی.', [[btn('✖️ انصراف', 'm')]]);
      return true;
    }
    case 'abuse_text': {
      if (!text && !msg.caption && !msg.photo) {
        await send(ctx, 'abuse_need_text', 'لطفاً توضیح بده.');
        return true;
      }
      await clearState(user.user_id);
      const t = await submitAbuse(ctx, user, Number(st.data.target) || 0, msg);
      await send(ctx, 'abuse_ok', `✅ گزارش #${fa(t.id)} ثبت شد و تیم بررسی می‌کند. ممنون که خبر دادی 🙏`, [[btn('🏠 منو', 'm')]]);
      return true;
    }
    default:
      if (isTeam(user)) {
        if (await adminText1(ctx, user, st, msg)) return true;
        if (await adminText2(ctx, user, st, msg)) return true;
      }
      return false;
  }
}

// ---------- message ----------

export async function onMessage(msg) {
  const ctx = createCtx({ userId: msg.from && msg.from.id, chatId: msg.chat && msg.chat.id });
  if (!msg.from || msg.from.is_bot || !msg.chat) return result(ctx, { ignored: 'no sender' });
  const cmdMatch = /^\/([A-Za-z0-9_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(String(msg.text || '').trim());
  if (msg.chat.type !== 'private') {
    if (cmdMatch && cmdMatch[1].toLowerCase() === 'setlog' && Number(msg.from.id) === OWNER_ID) {
      await setKv('log_chat', msg.chat.id);
      await send(ctx, 'log_hello', '📋 از این به بعد پیام‌های تیم ربات مادر این‌جا می‌آید.');
    }
    return result(ctx, { ignored: 'group' });
  }
  await seedOnce();
  const row = await touchUser(msg.from, { started: true });
  const isNew = !!(row && Number(row.is_new));
  const user = await getUser(msg.from.id);
  const team = isTeam(user);
  if (!team) {
    const b = await activeBan(user.user_id, 'mother');
    if (b) {
      if ((await spamCheck(user)) === 'ok') await banNotice(ctx, b);
      return result(ctx, { banned: true });
    }
    const spam = await spamCheck(user);
    if (spam === 'muted_now') {
      await send(ctx, 'muted', '⏳ پیام‌هایت خیلی زیاد شد؛ ۱۰ دقیقه صبر کن.');
      return result(ctx, { muted: true });
    }
    if (spam === 'muted') return result(ctx, { muted: true });
  }
  try {
    if (cmdMatch) {
      const handled = await onCommand(ctx, user, msg, cmdMatch[1].toLowerCase(), String(cmdMatch[2] || '').trim(), isNew);
      if (handled) {
        await afterUpdate(ctx);
        return result(ctx);
      }
    }
    const st = stateOf(user);
    if (st && st.name !== 'q_pending' && (await onStep(ctx, user, st, msg))) {
      await afterUpdate(ctx);
      return result(ctx);
    }
    const text = String(msg.text || msg.caption || '').trim();
    if (!text) {
      await send(ctx, 'hint', '💬 سؤالت را به‌صورت متن بنویس، یا از منو استفاده کن.', [[btn('🏠 منوی اصلی', 'm')]]);
    } else {
      const ans = await answerQuestion(user, truncate(text, 1500));
      await send(ctx, `answer_${ans.engine}`, ans.text, ans.kb);
      ctx.answerEngine = ans.engine;
    }
  } catch (err) {
    console.error('message failed:', err);
    await send(ctx, 'error', '⚠️ مشکلی پیش آمد؛ دوباره امتحان کن.');
  }
  await afterUpdate(ctx);
  return result(ctx, ctx.answerEngine ? { engine: ctx.answerEngine } : {});
}

// ---------- callback ----------

async function userCallback(ctx, user, data, st) {
  const [cmd, a] = data.split(':');
  const v = async (view, p) => {
    const r = await p;
    if (!r) return answer(ctx, 'پیدا نشد.', { alert: true });
    return show(ctx, view, r.text, r.kb);
  };
  switch (cmd) {
    case 'm':
      await clearState(user.user_id);
      await v('main', mainMenu(user));
      return true;
    case 'ask':
      await clearState(user.user_id);
      await v('ask', askPrompt());
      return true;
    case 'b':
      if (a) await openBot(ctx, user, a);
      else await v('bots', botsHome(user));
      return true;
    case 'bn':
      await v('newest', newestView());
      return true;
    case 'al':
      await v('all_bots', allBotsView(user));
      return true;
    case 'bc':
      await v('category', categoryView(user, a));
      return true;
    case 'bf':
      await v('features', featuresView(user, a));
      return true;
    case 'bq':
      await v('faq', faqView(user, a));
      return true;
    case 'ns': {
      if (!(await getBot(a))) return true;
      const on = await toggleSub(user.user_id, a);
      await answer(ctx, on ? '🔔 خبرهای این ربات برایت فرستاده می‌شود.' : '🔕 دیگر خبر این ربات نمی‌آید.');
      const r = await botCard(user, a);
      if (r) await show(ctx, 'bot_card', r.text, r.kb);
      return true;
    }
    case 'n':
      await v('news', newsView(user));
      return true;
    case 'nn': {
      if (a !== '*' && !(await getBot(a))) return true;
      const on = await toggleSub(user.user_id, a);
      await answer(ctx, on ? '🔔 روشن شد' : '🔕 خاموش شد');
      await v('news', newsView(await getUser(user.user_id)));
      return true;
    }
    case 'nk':
      await v('news_kinds', Promise.resolve(kindsView(user)));
      return true;
    case 'nkt':
      if ([1, 2, 4, 8].includes(Number(a))) await toggleKind(user, Number(a));
      await v('news_kinds', Promise.resolve(kindsView(await getUser(user.user_id))));
      return true;
    case 'st':
      await v('status', statusBoard(user));
      return true;
    case 'stw':
      await watchBot(ctx, user, a);
      return true;
    case 'r':
      if (a) await startReport(ctx, user, a);
      else await v('report_pick', reportPick(user));
      return true;
    case 'rok': {
      const t = await getTicket(a);
      if (t && t.user_id === user.user_id) await closeTicket(ctx, t.id);
      await show(ctx, 'report_solved', '🎉 عالی! خوشحالم که حل شد.', [[btn('🏠 منو', 'm')]]);
      return true;
    }
    case 'rno': {
      const t = await escalate(ctx, user, a);
      if (!t) return true;
      await show(ctx, 'report_escalated', `📝 گزارش #${fa(t.id)} برای تیم توسعه فرستاده شد. جواب همین‌جا می‌آید.`, [[btn('🎫 گزارش‌های من', 'tl'), btn('🏠 منو', 'm')]]);
      return true;
    }
    case 'tl':
      await v('tickets', ticketsView(user));
      return true;
    case 't': {
      const t = await getTicket(a);
      if (!t || t.user_id !== user.user_id) return answer(ctx, 'پیدا نشد.', { alert: true }).then(() => true);
      await v('ticket', ticketView(user, t));
      return true;
    }
    case 'tr': {
      const t = await getTicket(a);
      if (!t || t.user_id !== user.user_id) return true;
      await setState(user.user_id, 'ticket_reply', { tid: t.id });
      await send(ctx, 'ticket_reply_prompt', `✉️ پیامت برای تیم درباره‌ی گزارش #${fa(t.id)} را بفرست.`, [[btn('✖️ انصراف', 'm')]]);
      await answer(ctx);
      return true;
    }
    case 'tk': {
      const t = await getTicket(a);
      if (t && t.user_id === user.user_id) await closeTicket(ctx, t.id);
      await answer(ctx, '✅ بسته شد. ممنون!');
      return true;
    }
    case 'c':
      await v('club', clubView(user));
      return true;
    case 'cj':
      await joinClub(user.user_id);
      await answer(ctx, '🎉 به باشگاه خوش آمدی!');
      await v('club', clubView(await getUser(user.user_id)));
      return true;
    case 'cl':
      await leaveClub(user.user_id);
      await answer(ctx, 'از باشگاه خارج شدی. امتیازهایت می‌ماند.');
      await v('club', clubView(await getUser(user.user_id)));
      return true;
    case 'cc': {
      const r = await claimCode(ctx, user, a);
      if (r.error === 'not_member') {
        await answer(ctx, 'اول عضو باشگاه شو.', { alert: true });
        await v('club', clubView(user));
      } else if (r.error === 'level') {
        await answer(ctx, 'این تخفیف برای سطح بالاتری است.', { alert: true });
      } else if (r.error === 'shared') {
        await answer(ctx, `کد این تخفیف: ${r.campaign.code}`, { alert: true });
      } else if (r.error) {
        await answer(ctx, 'این تخفیف تمام شده.', { alert: true });
      } else {
        await send(ctx, 'code', `🎟 کد تخفیف شخصی تو${r.again ? ' (قبلاً گرفته بودی)' : ''}:\n\n<code>${esc(r.code)}</code>\n\n${fa(r.campaign.pct)}٪ · تا ${formatDate(r.campaign.ends_at)} · یک‌بار مصرف\nموقع خرید اشتراک در ربات وارد کن.`, [[btn('🎟 کدهای من', 'cm'), btn('🏠 منو', 'm')]]);
        await answer(ctx);
      }
      return true;
    }
    case 'cm':
      await v('my_codes', myCodesView(user));
      return true;
    case 'cr': {
      const name = await myUsername(ctx);
      const link = name ? `https://t.me/${name}?start=r_${user.user_id}` : null;
      await show(ctx, 'invite', `🔗 <b>لینک دعوت تو</b>\n\n${link ? `<code>${esc(link)}</code>` : '—'}\n\nهر دوستی که با این لینک ربات مادر را باز کند، اگر عضو باشگاه باشی امتیاز می‌گیری.`, [[btn('⬅️ باشگاه', 'c'), btn('🏠 منو', 'm')]]);
      return true;
    }
    case 'p':
      await v('profile', profileView(user));
      return true;
    case 'ua':
      await setState(user.user_id, 'abuse_who');
      await show(ctx, 'abuse_who', '🚨 <b>گزارش کاربر مزاحم</b>\n\nاگر کسی در یکی از ربات‌های Wanger اسپم فرستاده، مزاحم شده یا اختلال ایجاد کرده، یک پیام از او را این‌جا فوروارد کن یا آیدی عددی/یوزرنیمش را بفرست.', [[btn('✖️ انصراف', 'm')]]);
      return true;
    case 'qt': {
      if (!st || st.name !== 'q_pending' || !st.data.q) {
        await answer(ctx, 'سؤالت را دوباره بنویس، بعد این دکمه را بزن.', { alert: true });
        return true;
      }
      if (await overLimit(user)) {
        await answer(ctx, 'امروز به سقف پیام به تیم رسیده‌ای.', { alert: true });
        return true;
      }
      await clearState(user.user_id);
      const t = await submitQuestion(ctx, user, st.data.q, st.data.bot);
      await show(ctx, 'question_sent', `✉️ سؤالت (#${fa(t.id)}) برای تیم فرستاده شد؛ جواب همین‌جا می‌آید.`, [[btn('🏠 منو', 'm')]]);
      return true;
    }
    default:
      return false;
  }
}

export async function onCallback(q) {
  const ctx = createCtx({
    userId: q.from && q.from.id, chatId: q.message && q.message.chat && q.message.chat.id, messageId: q.message && q.message.message_id, callbackId: q.id,
  });
  const data = String(q.data || '');
  try {
    await seedOnce();
    await touchUser(q.from, { started: !!(q.message && q.message.chat && q.message.chat.type === 'private') });
    const user = await getUser(q.from.id);
    const team = isTeam(user);
    if (!team) {
      const b = await activeBan(user.user_id, 'mother');
      if (b) {
        await answer(ctx, '⛔️ دسترسی شما محدود شده است.', { alert: true });
        return result(ctx, { banned: true });
      }
    }
    const st = stateOf(user);
    let handled = await userCallback(ctx, user, data, st);
    if (!handled && team) handled = (await adminCallback1(ctx, user, data)) || (await adminCallback2(ctx, user, data, st));
    if (!handled) await answer(ctx, team ? 'این دکمه دیگر کار نمی‌کند.' : '');
  } catch (err) {
    console.error(`callback ${data} failed:`, err);
    await answer(ctx, '⚠️ مشکلی پیش آمد.', { alert: false });
  }
  await answer(ctx);
  await afterUpdate(ctx);
  return result(ctx);
}

// ---------- channel posts, polls, chat member ----------

export async function onChannelPost(post) {
  const ctx = createCtx({ chatId: post && post.chat && post.chat.id });
  let hub = { hub: false };
  try {
    hub = await onHubPost(ctx, post);
  } catch (err) {
    console.error('hub post failed:', err);
  }
  if (hub.hub) await afterUpdate(ctx);
  return result(ctx, { hub });
}

export async function onPoll(poll) {
  const ctx = createCtx();
  if (!(await isOurWake(poll))) return result(ctx, { ignored: 'not our wake' });
  await afterUpdate(ctx, { woken: true });
  return result(ctx, { woken: true });
}

export async function onMyChatMember(upd) {
  const ctx = createCtx();
  if (upd && upd.chat && upd.chat.type === 'private' && upd.from) {
    const status = upd.new_chat_member && upd.new_chat_member.status;
    if (status === 'kicked') await markBlocked(upd.from.id);
    else if (status === 'member') await touchUser(upd.from, { started: true });
  }
  return result(ctx);
}

/** The scheduled tick (endpoints/tick): due work with full limits. */
export async function onTick() {
  const ctx = createCtx();
  await seedOnce();
  const done = await afterUpdate(ctx, { tick: true });
  return { ok: true, done, trace: ctx.trace.length };
}

export const describe = describeError;
export const OWNER = OWNER_ID;

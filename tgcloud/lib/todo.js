// The to-do features: add, list, toggle, edit, delete, priority, due date, categories, search,
// stats and clearing completed tasks. Every task/category id that arrives in callback_data is
// re-checked against the user in SQL (store.js filters by user_id), so another user's id is
// simply "not found".
import { MAX_CATEGORIES, MAX_CATEGORY_LEN, MAX_SEARCH_LEN, MAX_TASK_LEN, MAX_TASKS, PAGE_SIZE } from './config.js';
import { addDays, dateOf, formatJalali, parseDate, today } from './dates.js';
import { answer, btn, send, show } from './tg.js';
import { charLength, esc, fa, normalize, short } from './text.js';
import { HELP_TEXT, PRIORITY, SORT, mainMenuKeyboard, menuBtn, welcomeText } from './ui.js';
import * as store from './store.js';

// ---------- navigation context ----------
// Screens that open a task remember where they came from: "l<page>.<category>" (the list) or
// "s<page>" (search results). It travels in callback_data so "back" returns to the same page.

export function parseBack(code) {
  let m = /^l(\d{1,4})\.(\d{1,15})$/.exec(code || '');
  if (m) return { kind: 'l', page: Number(m[1]), cat: Number(m[2]), code };
  m = /^s(\d{1,4})$/.exec(code || '');
  if (m) return { kind: 's', page: Number(m[1]), code };
  return { kind: 'l', page: 0, cat: 0, code: 'l0.0' };
}

const backData = (back) => (back.kind === 's' ? `sr:${back.page}` : `l:${back.page}:${back.cat}`);

function showBack(ctx, user, back, notice) {
  return back.kind === 's' ? showSearch(ctx, user, back.page, notice) : showList(ctx, user, back.page, back.cat, notice);
}

const withNotice = (notice, text) => (notice ? `${notice}\n\n${text}` : text);
const cancelBtn = (data) => btn('❌ انصراف', data);

// ---------- menu, help ----------

export function showMenu(ctx, user, notice) {
  return show(ctx, 'menu', withNotice(notice, welcomeText(ctx.firstName)), mainMenuKeyboard(user.id));
}

export function showHelp(ctx) {
  return show(ctx, 'help', HELP_TEXT, [[btn('📋 لیست کارها', 'l:0:0'), menuBtn()]]);
}

// ---------- task rendering ----------

const isOverdue = (task, todayIso) => !task.done && !!task.dueDate && task.dueDate < todayIso;

function taskLine(task, n, todayIso) {
  const body = esc(short(task.text, 60));
  const due = task.dueDate ? ` — 📅 ${formatJalali(task.dueDate)}${isOverdue(task, todayIso) ? ' ⏰' : ''}` : '';
  return `${fa(n)}. ${task.done ? '✅' : '⬜️'} ${PRIORITY[task.priority].icon} ${task.done ? `<s>${body}</s>` : body}${due}`;
}

function taskButtons(task, n, back, todayIso) {
  return [
    btn(task.done ? '✅' : '⬜️', `tl:${task.id}:${back.code}`),
    btn(`${fa(n)}. ${PRIORITY[task.priority].icon} ${short(task.text, 26)}${isOverdue(task, todayIso) ? ' ⏰' : ''}`, `v:${task.id}:${back.code}`),
  ];
}

function navRow(page, pages, dataFor) {
  if (pages <= 1) return null;
  const row = [];
  if (page > 0) row.push(btn('« قبلی', dataFor(page - 1)));
  row.push(btn(`${fa(page + 1)} از ${fa(pages)}`, 'n'));
  if (page < pages - 1) row.push(btn('بعدی »', dataFor(page + 1)));
  return row;
}

const clampPage = (page, pages) => Math.min(Math.max(Number.isFinite(page) ? page : 0, 0), pages - 1);

// ---------- 2. list (paginated, 8 per page) + 8. category filter + 6. sort ----------

export async function showList(ctx, user, pageArg, catArg, notice) {
  let catId = catArg > 0 ? catArg : 0;
  const category = catId ? await store.getCategory(user.id, catId) : null;
  if (!category) catId = 0;
  const total = await store.countList(user.id, catId);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = clampPage(pageArg, pages);
  const tasks = total ? await store.listTasks(user.id, { categoryId: catId, sort: user.sort, page }) : [];
  const back = parseBack(`l${page}.${catId}`);
  const todayIso = today();
  const sort = SORT[user.sort] || SORT.p;

  let text = `📋 <b>کارهای شما</b>${category ? ` — 🗂 ${esc(category.name)}` : ''}\n`;
  if (!total) {
    text += category ? '\nدر این دسته هنوز کاری نیست.' : '\nهنوز کاری ثبت نکرده‌اید ✍️\nمتن کار را بفرستید تا اضافه شود.';
  } else {
    text += `مرتب‌سازی: ${sort.label} | ${fa(total)} کار | صفحه ${fa(page + 1)} از ${fa(pages)}\n\n`;
    text += tasks.map((t, i) => taskLine(t, page * PAGE_SIZE + i + 1, todayIso)).join('\n');
    text += '\n\n<i>⬜️ / ✅ وضعیت را عوض می‌کند؛ برای جزئیات روی خود کار بزنید.</i>';
  }

  const kb = tasks.map((t, i) => taskButtons(t, page * PAGE_SIZE + i + 1, back, todayIso));
  const nav = navRow(page, pages, (p) => `l:${p}:${catId}`);
  if (nav) kb.push(nav);
  kb.push([btn(`🔃 مرتب‌سازی: ${sort.label}`, `so:${page}:${catId}`), btn('🗂 دسته‌ها', 'cats')]);
  if (catId) kb.push([btn('📋 همه‌ی کارها', 'l:0:0')]);
  kb.push([btn('➕ افزودن کار', 'add'), menuBtn()]);
  return show(ctx, 'list', withNotice(notice, text), kb);
}

export async function cycleSort(ctx, user, page, catId) {
  user.sort = (SORT[user.sort] || SORT.p).next;
  await store.setSort(user.id, user.sort);
  await answer(ctx, `مرتب‌سازی: ${SORT[user.sort].label}`);
  return showList(ctx, user, page, catId);
}

// ---------- task card ----------

async function taskGone(ctx, user, back) {
  await answer(ctx, '⚠️ این کار پیدا نشد (شاید حذف شده باشد).', true);
  return showBack(ctx, user, back);
}

export async function showTask(ctx, user, taskId, back, notice) {
  const task = await store.getTask(user.id, taskId);
  if (!task) return taskGone(ctx, user, back);
  const todayIso = today();
  const p = PRIORITY[task.priority];
  const due = task.dueDate
    ? `📅 ${formatJalali(task.dueDate)}${isOverdue(task, todayIso) ? ' — ⏰ <b>عقب‌افتاده</b>' : ''}`
    : 'ندارد';
  const text = '📝 <b>جزئیات کار</b>\n\n'
    + `${esc(task.text)}\n\n`
    + `وضعیت: ${task.done ? '✅ انجام‌شده' : '⬜️ انجام‌نشده'}\n`
    + `اولویت: ${p.icon} ${p.name}\n`
    + `سررسید: ${due}\n`
    + `دسته: ${task.category ? `🗂 ${esc(task.category)}` : 'ندارد'}\n`
    + `ثبت‌شده: ${formatJalali(dateOf(task.createdAt))}`;
  const b = back.code;
  const id = task.id;
  const kb = [
    [btn(task.done ? '↩️ برگرداندن به انجام‌نشده' : '✅ انجام شد', `tv:${id}:${b}`)],
    [1, 2, 3].map((v) => btn(`${v === task.priority ? '✔️ ' : ''}${PRIORITY[v].icon} ${PRIORITY[v].name}`, `ps:${id}:${v}:${b}`)),
    [btn('✏️ ویرایش متن', `e:${id}:${b}`), btn('📅 سررسید', `u:${id}:${b}`)],
    [btn('🗂 دسته', `c:${id}:${b}`), btn('🗑 حذف', `d:${id}:${b}`)],
    [btn('🔙 بازگشت', backData(back)), menuBtn()],
  ];
  return show(ctx, 'task', withNotice(notice, text), kb);
}

// ---------- 1. add ----------

export async function promptAdd(ctx, user) {
  await store.setState(user.id, 'add');
  return show(ctx, 'add_prompt', `➕ متن کار جدید را بفرستید:\n<i>(حداکثر ${fa(MAX_TASK_LEN)} کاراکتر)</i>`, [[cancelBtn('x')]]);
}

/** Adds a task from what the user typed. Returns true if it was added. */
export async function addTaskFlow(ctx, user, raw) {
  const text = normalize(raw);
  if (!text) {
    await send(ctx, 'add_empty', '✍️ متن کار خالی است؛ لطفاً متن کار را بفرستید.');
    return false;
  }
  const len = charLength(text);
  if (len > MAX_TASK_LEN) {
    await send(ctx, 'add_too_long', `⚠️ متن کار حداکثر ${fa(MAX_TASK_LEN)} کاراکتر می‌تواند باشد (متن شما ${fa(len)} کاراکتر است). لطفاً کوتاه‌ترش کنید و دوباره بفرستید.`);
    return false;
  }
  if ((await store.countTasks(user.id)) >= MAX_TASKS) {
    await send(ctx, 'add_limit',
      `⚠️ به سقف ${fa(MAX_TASKS)} کار رسیده‌اید. برای افزودن کار جدید، چند کار را حذف کنید یا کارهای انجام‌شده را پاک کنید.`,
      [[btn('📊 آمار و پاک‌سازی', 'st'), btn('📋 لیست کارها', 'l:0:0')]]);
    return false;
  }
  const id = await store.addTask(user.id, text);
  await showTask(ctx, user, id, parseBack('l0.0'), '✅ <b>کار جدید اضافه شد.</b>\nاولویت، سررسید یا دسته‌اش را از دکمه‌های زیر تنظیم کنید.');
  return true;
}

// ---------- 3. toggle done ----------

export async function toggleFromList(ctx, user, taskId, back) {
  const done = await store.toggleTask(user.id, taskId);
  if (done === null) return taskGone(ctx, user, back);
  await answer(ctx, done ? '✅ انجام شد' : '↩️ برگشت به انجام‌نشده');
  return showBack(ctx, user, back);
}

export async function toggleFromTask(ctx, user, taskId, back) {
  const done = await store.toggleTask(user.id, taskId);
  if (done === null) return taskGone(ctx, user, back);
  await answer(ctx, done ? '✅ انجام شد' : '↩️ برگشت به انجام‌نشده');
  return showTask(ctx, user, taskId, back);
}

// ---------- 4. edit text ----------

export async function promptEdit(ctx, user, taskId, back) {
  const task = await store.getTask(user.id, taskId);
  if (!task) return taskGone(ctx, user, back);
  await store.setState(user.id, 'edit', { id: task.id, b: back.code });
  return show(ctx, 'edit_prompt', `✏️ متن جدید این کار را بفرستید:\n\n<blockquote>${esc(task.text)}</blockquote>`,
    [[cancelBtn(`v:${task.id}:${back.code}`)]]);
}

export async function editInput(ctx, user, raw) {
  const { id, b } = user.stateData;
  const back = parseBack(b);
  const text = normalize(raw);
  const len = charLength(text);
  if (!text || len > MAX_TASK_LEN) {
    return send(ctx, 'edit_invalid',
      text ? `⚠️ متن کار حداکثر ${fa(MAX_TASK_LEN)} کاراکتر است (متن شما ${fa(len)} کاراکتر). دوباره بفرستید:` : '✍️ متن خالی است؛ متن جدید را بفرستید:',
      [[cancelBtn(`v:${id}:${back.code}`)]]);
  }
  await store.clearState(user.id);
  if (!(await store.updateTaskText(user.id, id, text))) return taskGone(ctx, user, back);
  return showTask(ctx, user, id, back, '✅ متن کار ویرایش شد.');
}

// ---------- 6. priority ----------

export async function setPriority(ctx, user, taskId, value, back) {
  if (![1, 2, 3].includes(value)) return showTask(ctx, user, taskId, back);
  if (!(await store.setPriority(user.id, taskId, value))) return taskGone(ctx, user, back);
  await answer(ctx, `اولویت: ${PRIORITY[value].icon} ${PRIORITY[value].name}`);
  return showTask(ctx, user, taskId, back);
}

// ---------- 7. due date ----------

export async function promptDue(ctx, user, taskId, back) {
  const task = await store.getTask(user.id, taskId);
  if (!task) return taskGone(ctx, user, back);
  await store.setState(user.id, 'due', { id: task.id, b: back.code });
  const b = back.code;
  const current = task.dueDate ? `\nسررسید فعلی: 📅 ${formatJalali(task.dueDate)}\n` : '';
  const kb = [[btn('امروز', `ud:${task.id}:t:${b}`), btn('فردا', `ud:${task.id}:m:${b}`), btn('یک هفته بعد', `ud:${task.id}:w:${b}`)]];
  if (task.dueDate) kb.push([btn('🗑 حذف سررسید', `ud:${task.id}:x:${b}`)]);
  kb.push([cancelBtn(`v:${task.id}:${b}`)]);
  return show(ctx, 'due_prompt',
    `📅 <b>تاریخ سررسید</b> را بفرستید:\n${current}\n• شمسی: <code>1405/08/10</code>\n• میلادی: <code>2026-11-01</code>\n\nیا یکی از دکمه‌ها را بزنید:`,
    kb);
}

function dueNotice(isoDate) {
  if (!isoDate) return '🗑 سررسید حذف شد.';
  return `✅ سررسید ثبت شد: 📅 ${formatJalali(isoDate)}${isoDate < today() ? '\n⏰ این تاریخ گذشته است.' : ''}`;
}

export async function quickDue(ctx, user, taskId, code, back) {
  const t = today();
  const value = { t, m: addDays(t, 1), w: addDays(t, 7), x: null }[code];
  if (value === undefined) return showTask(ctx, user, taskId, back);
  if (!(await store.setDueDate(user.id, taskId, value))) return taskGone(ctx, user, back);
  await answer(ctx, value ? '📅 سررسید ثبت شد' : '🗑 سررسید حذف شد');
  return showTask(ctx, user, taskId, back, dueNotice(value));
}

export async function dueInput(ctx, user, raw) {
  const { id, b } = user.stateData;
  const back = parseBack(b);
  const value = parseDate(raw);
  if (!value) {
    return send(ctx, 'due_invalid',
      '⚠️ این تاریخ معتبر نیست.\nنمونه‌ی درست: <code>1405/08/10</code> (شمسی) یا <code>2026-11-01</code> (میلادی). دوباره بفرستید:',
      [[cancelBtn(`v:${id}:${back.code}`)]]);
  }
  await store.clearState(user.id);
  if (!(await store.setDueDate(user.id, id, value))) return taskGone(ctx, user, back);
  return showTask(ctx, user, id, back, dueNotice(value));
}

// ---------- 8. categories ----------

export async function showCategories(ctx, user, notice) {
  const cats = await store.listCategories(user.id);
  const text = cats.length
    ? '🗂 <b>دسته‌بندی‌ها</b>\n\nروی هر دسته بزنید تا کارهایش را ببینید.\n<i>عدد داخل پرانتز = کارهای باز</i>'
    : '🗂 <b>دسته‌بندی‌ها</b>\n\nهنوز دسته‌ای نساخته‌اید.\nبا «➕ دسته‌ی جدید» یکی بسازید؛ بعد در صفحه‌ی هر کار، با دکمه‌ی «🗂 دسته» آن را به دسته بدهید.';
  const kb = cats.map((c) => [btn(`📂 ${short(c.name, 24)} (${fa(c.open)})`, `l:0:${c.id}`), btn('🗑', `cd:${c.id}`)]);
  if (cats.length < MAX_CATEGORIES) kb.push([btn('➕ دسته‌ی جدید', 'cn')]);
  kb.push([btn('📋 همه‌ی کارها', 'l:0:0'), menuBtn()]);
  return show(ctx, 'categories', withNotice(notice, text), kb);
}

export async function chooseCategory(ctx, user, taskId, back) {
  const task = await store.getTask(user.id, taskId);
  if (!task) return taskGone(ctx, user, back);
  const cats = await store.listCategories(user.id);
  const b = back.code;
  const kb = [];
  for (let i = 0; i < cats.length; i += 2) {
    kb.push(cats.slice(i, i + 2).map((c) => btn(`${c.id === task.categoryId ? '✔️ ' : ''}📂 ${short(c.name, 20)}`, `cs:${task.id}:${c.id}:${b}`)));
  }
  if (task.categoryId) kb.push([btn('🚫 بدون دسته', `cs:${task.id}:0:${b}`)]);
  if (cats.length < MAX_CATEGORIES) kb.push([btn('➕ دسته‌ی جدید', `cn:${task.id}:${b}`)]);
  kb.push([btn('🔙 بازگشت', `v:${task.id}:${b}`)]);
  const text = cats.length ? '🗂 دسته‌ی این کار را انتخاب کنید:' : '🗂 هنوز دسته‌ای ندارید؛ اول یک دسته بسازید:';
  return show(ctx, 'choose_category', `${text}\n\n<i>${esc(short(task.text, 80))}</i>`, kb);
}

export async function setCategory(ctx, user, taskId, catId, back) {
  let category = null;
  if (catId > 0) {
    category = await store.getCategory(user.id, catId);
    if (!category) {
      await answer(ctx, '⚠️ این دسته پیدا نشد.', true);
      return chooseCategory(ctx, user, taskId, back);
    }
  }
  if (!(await store.setTaskCategory(user.id, taskId, category ? category.id : null))) return taskGone(ctx, user, back);
  await answer(ctx, category ? `🗂 دسته: ${short(category.name, 30)}` : '🚫 بدون دسته');
  return showTask(ctx, user, taskId, back);
}

export async function promptCategory(ctx, user, taskId, back) {
  if ((await store.countCategories(user.id)) >= MAX_CATEGORIES) {
    await answer(ctx, `⚠️ حداکثر ${fa(MAX_CATEGORIES)} دسته می‌توانید داشته باشید.`, true);
    return taskId ? chooseCategory(ctx, user, taskId, back) : showCategories(ctx, user);
  }
  if (taskId && !(await store.getTask(user.id, taskId))) return taskGone(ctx, user, back);
  await store.setState(user.id, 'cat', taskId ? { task: taskId, b: back.code } : {});
  return show(ctx, 'category_prompt', `🗂 نام دسته‌ی جدید را بفرستید:\n<i>(حداکثر ${fa(MAX_CATEGORY_LEN)} کاراکتر)</i>`,
    [[cancelBtn(taskId ? `c:${taskId}:${back.code}` : 'cats')]]);
}

export async function categoryInput(ctx, user, raw) {
  const { task, b } = user.stateData;
  const back = parseBack(b);
  const name = normalize(raw).replace(/\s+/g, ' ');
  const len = charLength(name);
  if (!name || len > MAX_CATEGORY_LEN) {
    return send(ctx, 'category_invalid', `⚠️ نام دسته باید بین ۱ تا ${fa(MAX_CATEGORY_LEN)} کاراکتر باشد. دوباره بفرستید:`,
      [[cancelBtn(task ? `c:${task}:${back.code}` : 'cats')]]);
  }
  await store.clearState(user.id);
  if ((await store.countCategories(user.id)) >= MAX_CATEGORIES) {
    return showCategories(ctx, user, `⚠️ حداکثر ${fa(MAX_CATEGORIES)} دسته می‌توانید داشته باشید.`);
  }
  const { id, created } = await store.addCategory(user.id, name);
  if (task) {
    if (!(await store.setTaskCategory(user.id, task, id))) return taskGone(ctx, user, back);
    return showTask(ctx, user, task, back, `✅ دسته‌ی «${esc(name)}» ${created ? 'ساخته شد و ' : ''}به این کار داده شد.`);
  }
  return showCategories(ctx, user, created ? `✅ دسته‌ی «${esc(name)}» ساخته شد.` : `ℹ️ دسته‌ی «${esc(name)}» از قبل وجود داشت.`);
}

export async function confirmDeleteCategory(ctx, user, catId) {
  const cat = await store.getCategory(user.id, catId);
  if (!cat) {
    await answer(ctx, '⚠️ این دسته پیدا نشد.', true);
    return showCategories(ctx, user);
  }
  return show(ctx, 'category_delete_confirm',
    `🗑 دسته‌ی «${esc(cat.name)}» حذف شود؟\n\nکارهای داخل آن حذف نمی‌شوند و فقط بدون دسته می‌شوند.`,
    [[btn('✅ بله، حذف کن', `cdy:${cat.id}`), btn('❌ نه', 'cats')]]);
}

export async function deleteCategory(ctx, user, catId) {
  const ok = await store.deleteCategory(user.id, catId);
  await answer(ctx, ok ? '🗑 دسته حذف شد' : '⚠️ این دسته پیدا نشد.', !ok);
  return showCategories(ctx, user, ok ? '🗑 دسته حذف شد.' : undefined);
}

// ---------- 5. delete (with confirmation) ----------

export async function confirmDelete(ctx, user, taskId, back) {
  const task = await store.getTask(user.id, taskId);
  if (!task) return taskGone(ctx, user, back);
  return show(ctx, 'delete_confirm',
    `🗑 این کار حذف شود؟\n\n<blockquote>${esc(short(task.text, 200))}</blockquote>\n\nاین کار قابل بازگشت نیست.`,
    [[btn('✅ بله، حذف شود', `dy:${task.id}:${back.code}`), btn('❌ نه', `v:${task.id}:${back.code}`)]]);
}

export async function deleteTask(ctx, user, taskId, back) {
  if (!(await store.deleteTask(user.id, taskId))) return taskGone(ctx, user, back);
  await answer(ctx, '🗑 کار حذف شد');
  return showBack(ctx, user, back, '🗑 کار حذف شد.');
}

// ---------- 9. search ----------

export async function promptSearch(ctx, user) {
  await store.setState(user.id, 'search');
  return show(ctx, 'search_prompt', '🔍 کلمه یا عبارتی را که دنبالش هستید بفرستید:', [[cancelBtn('x')]]);
}

export async function searchInput(ctx, user, raw) {
  const query = normalize(raw).replace(/\s+/g, ' ');
  const len = charLength(query);
  if (!query || len > MAX_SEARCH_LEN) {
    return send(ctx, 'search_invalid', `⚠️ عبارت جستجو باید بین ۱ تا ${fa(MAX_SEARCH_LEN)} کاراکتر باشد. دوباره بفرستید:`, [[cancelBtn('x')]]);
  }
  await store.clearState(user.id);
  await store.setLastSearch(user.id, query);
  user.lastSearch = query;
  return showSearch(ctx, user, 0);
}

export async function showSearch(ctx, user, pageArg, notice) {
  const query = user.lastSearch;
  if (!query) return promptSearch(ctx, user);
  const total = await store.countSearch(user.id, query);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = clampPage(pageArg, pages);
  const tasks = total ? await store.searchTasks(user.id, query, page) : [];
  const back = parseBack(`s${page}`);
  const todayIso = today();
  let text = `🔍 <b>نتایج جستجو</b> برای «${esc(query)}»\n`;
  text += total
    ? `${fa(total)} مورد پیدا شد | صفحه ${fa(page + 1)} از ${fa(pages)}\n\n${tasks.map((t, i) => taskLine(t, page * PAGE_SIZE + i + 1, todayIso)).join('\n')}`
    : '\nچیزی پیدا نشد 🤷';
  const kb = tasks.map((t, i) => taskButtons(t, page * PAGE_SIZE + i + 1, back, todayIso));
  const nav = navRow(page, pages, (p) => `sr:${p}`);
  if (nav) kb.push(nav);
  kb.push([btn('🔍 جستجوی دوباره', 's'), menuBtn()]);
  return show(ctx, 'search_results', withNotice(notice, text), kb);
}

// ---------- 10. stats + clear completed ----------

export async function showStats(ctx, user, notice) {
  const s = await store.stats(user.id, today());
  const pct = s.total ? Math.round((s.done * 100) / s.total) : 0;
  const filled = Math.round(pct / 10);
  const text = '📊 <b>آمار کارهای شما</b>\n\n'
    + `📌 کل کارها: ${fa(s.total)}\n`
    + `✅ انجام‌شده: ${fa(s.done)}\n`
    + `⬜️ باز: ${fa(s.open)}\n`
    + `⏰ عقب‌افتاده: ${fa(s.overdue)}\n\n`
    + `پیشرفت: ${'▰'.repeat(filled)}${'▱'.repeat(10 - filled)} ${fa(pct)}٪`;
  const kb = [];
  if (s.done > 0) kb.push([btn(`🧹 پاک‌کردن ${fa(s.done)} کار انجام‌شده`, 'cc')]);
  kb.push([btn('📋 لیست کارها', 'l:0:0'), menuBtn()]);
  return show(ctx, 'stats', withNotice(notice, text), kb);
}

export async function confirmClearDone(ctx, user) {
  const s = await store.stats(user.id, today());
  if (!s.done) {
    await answer(ctx, 'کار انجام‌شده‌ای برای پاک کردن نیست.', true);
    return showStats(ctx, user);
  }
  return show(ctx, 'clear_confirm',
    `🧹 <b>پاک‌کردن کارهای انجام‌شده</b>\n\n${fa(s.done)} کار انجام‌شده برای همیشه حذف شود؟`,
    [[btn('✅ بله، پاک کن', 'ccy'), btn('❌ نه', 'st')]]);
}

export async function clearDone(ctx, user) {
  const n = await store.clearDone(user.id);
  await answer(ctx, n ? `🧹 ${fa(n)} کار پاک شد` : 'کاری برای پاک کردن نبود');
  return showStats(ctx, user, n ? `🧹 ${fa(n)} کار انجام‌شده پاک شد.` : undefined);
}

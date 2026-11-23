// Wanger News dashboard (Phase 6). Plain JS, no build step. Every value from the API is put on
// the page as text nodes (never parsed as HTML): article text is untrusted input.
"use strict";

const KEY = "wanger-news-token";
const $ = (sel) => document.querySelector(sel);
const view = $("#view");

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "onclick") node.addEventListener("click", v);
    else if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function say(text, error = false) {
  const m = $("#message");
  m.textContent = text;
  m.className = error ? "error" : "";
}

async function api(path, options = {}) {
  const token = sessionStorage.getItem(KEY);
  const res = await fetch(path, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    credentials: "omit",
    cache: "no-store",
  });
  if (res.status === 401) {
    logout();
    throw new Error("توکن نادرست است.");
  }
  if (!res.ok) throw new Error(`خطای ${res.status}`);
  return res.json();
}

function safeLink(url, text) {
  if (typeof url !== "string" || !/^https:\/\//.test(url)) return document.createTextNode(text || "");
  return el("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, text || url);
}

function table(headers, rows) {
  return el("table", {},
    el("thead", {}, el("tr", {}, headers.map((h) => el("th", {}, h)))),
    el("tbody", {}, rows.map((cells) => el("tr", {}, cells.map((c) => el("td", {}, c))))));
}

function cards(pairs) {
  return el("div", { class: "cards" },
    pairs.map(([label, value]) => el("div", { class: "card" }, el("b", {}, value ?? "—"), label)));
}

async function act(path, done) {
  try {
    const result = await api(path, { method: "POST" });
    say(typeof result.result === "string" ? result.result : "انجام شد.");
    await done();
  } catch (e) { say(e.message, true); }
}

const tabs = {
  async status() {
    const s = await api("/api/status");
    const a = s.articles || {};
    view.replaceChildren(cards([
      ["انتشار", s.paused ? "متوقف" : "فعال"],
      ["منتظر بررسی", a.pending_review || 0],
      ["در صف انتشار", a.queued || 0],
      ["منتشرشده", a.published || 0],
      ["فراخوانی AI در ۲۴ ساعت", (s.ai_24h || {}).calls || 0],
      ["آخرین اجرا", s.last_run ? `${s.last_run.status} — ${s.last_run.started_at}` : "—"],
    ]));
  },
  async pending() {
    const rows = await api("/api/articles?status=pending_review&limit=100");
    const reload = () => tabs.pending();
    view.replaceChildren(rows.length ? table(
      ["#", "عنوان", "منبع", "دلیل", "اهمیت", ""],
      rows.map((r) => [
        String(r.id), safeLink(r.url, r.title_fa || r.title_original), r.source_id,
        r.review_reason || "", String(r.importance ?? ""),
        el("span", {},
          el("button", { class: "primary", onclick: () => act(`/api/articles/${r.id}/approve`, reload) }, "تأیید"), " ",
          el("button", { onclick: () => act(`/api/articles/${r.id}/publish`, reload) }, "انتشار فوری"), " ",
          el("button", { class: "danger", onclick: () => act(`/api/articles/${r.id}/reject`, reload) }, "رد")),
      ])) : el("p", { class: "muted" }, "چیزی منتظر بررسی نیست."));
  },
  async stories() {
    const rows = await api("/api/stories?days=3&limit=100");
    view.replaceChildren(table(
      ["#", "عنوان", "دسته", "منابع مستقل", "اهمیت", "اعتماد", "انتشار"],
      rows.map((s) => [String(s.id), s.title || "", s.category || "", String(s.independent_sources),
        String(s.importance ?? ""), String(s.confidence ?? ""), s.published_at || "—"])));
  },
  async search() {
    const input = el("input", { type: "search", placeholder: "کلمه یا عبارت", maxlength: "200" });
    const mode = el("select", {}, el("option", { value: "auto" }, "متنی + معنایی"),
      el("option", { value: "text" }, "فقط متنی"), el("option", { value: "semantic" }, "فقط معنایی"));
    const out = el("div");
    const form = el("form", {}, input, mode, el("button", { class: "primary", type: "submit" }, "جستجو"));
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      try {
        const q = encodeURIComponent(input.value);
        const r = await api(`/api/search?q=${q}&mode=${mode.value}`);
        if (r.error) { out.replaceChildren(el("p", { class: "muted" }, r.error)); return; }
        out.replaceChildren(r.hits.length ? table(["عنوان", "زمان", "نوع تطبیق", "بخشی از متن"],
          r.hits.map((h) => [safeLink(h.post_url || h.source_url, h.title), h.sent_at,
            h.match === "semantic" ? `معنایی (${h.score})` : "متنی", h.snippet || ""]))
          : el("p", { class: "muted" }, "چیزی پیدا نشد."));
      } catch (e) { say(e.message, true); }
    });
    view.replaceChildren(form, out);
  },
  async weekly() {
    const r = await api("/api/weekly");
    const w = r.report;
    view.replaceChildren(
      cards([["خبرها", w.stories], ["به‌روزرسانی‌ها", w.update_posts], ["چندمنبعی", w.multi_source],
        ["فوری", w.breaking_posts], ["متناقض", w.contradictions], ["اصلاحیه", w.corrections]]),
      el("h3", {}, "مهم‌ترین رویدادها"),
      table(["عنوان", "اهمیت", "منابع مستقل", "به‌روزرسانی"],
        w.top.map((s) => [safeLink(s.url, s.title), String(s.importance), String(s.independent_sources), String(s.updates)])),
      el("h3", {}, "پیش‌نمایش متن کانال"),
      el("pre", {}, r.text || "هنوز خبر کافی منتشر نشده."));
  },
  async sources() {
    const rows = await api("/api/sources");
    const reload = () => tabs.sources();
    view.replaceChildren(table(["منبع", "نوع", "وضعیت", "اعتبار", ""],
      rows.map((s) => [s.name, s.transport, s.active ? "روشن" : `خاموش (${s.inactive_reason || ""})`,
        String(s.reliability_score),
        s.switchable && s.transport === "rss" ? el("button", { onclick: () => act(`/api/sources/${encodeURIComponent(s.id)}/toggle`, reload) },
          s.active ? "خاموش کن" : "روشن کن") : "🔒"])));
  },
  async rules() {
    const rows = await api("/api/rules");
    const reload = () => tabs.rules();
    view.replaceChildren(table(["قانون", "توضیح", "وضعیت", ""],
      rows.map((r) => [r.id, r.description || "", r.enabled ? "روشن" : "خاموش",
        el("button", { onclick: () => act(`/api/rules/${encodeURIComponent(r.id)}/toggle`, reload) },
          r.enabled ? "خاموش کن" : "روشن کن")])));
  },
  async editions() {
    const rows = await api("/api/editions");
    const reload = () => tabs.editions();
    view.replaceChildren(rows.length ? table(["شناسه", "کانال", "زبان", "دسته‌ها", "حداقل اهمیت", "وضعیت", ""],
      rows.map((e) => [e.id, e.chat, e.language, (e.categories || []).join("، ") || "همه",
        String(e.min_importance), e.active ? "فعال" : "خاموش",
        el("button", { onclick: () => act(`/api/editions/${encodeURIComponent(e.id)}/toggle`, reload) },
          e.active ? "خاموش کن" : "روشن کن")]))
      : el("p", { class: "muted" }, "هنوز نسخه‌ای ندارید (در ربات: /panel ← نسخه‌ها)."));
  },
  async analytics() {
    const r = await api("/api/analytics?days=7");
    view.replaceChildren(el("pre", {}, JSON.stringify(r, null, 2)));
  },
  async corrections() {
    const rows = await api("/api/corrections?status=proposed");
    const reload = () => tabs.corrections();
    view.replaceChildren(rows.length ? table(["#", "مورد", "قبلی", "درست", "منبع", ""],
      rows.map((c) => [String(c.id), c.item, c.old, c.new, c.source || "",
        el("span", {},
          el("button", { class: "primary", onclick: () => act(`/api/corrections/${c.id}/approve`, reload) }, "تأیید"), " ",
          el("button", { class: "danger", onclick: () => act(`/api/corrections/${c.id}/reject`, reload) }, "رد"))]))
      : el("p", { class: "muted" }, "اصلاحیه‌ای منتظر نیست."));
  },
  async reliability() {
    const rows = await api("/api/reliability");
    const reload = () => tabs.reliability();
    view.replaceChildren(rows.length ? table(["#", "منبع", "فعلی", "پیشنهادی", "دلیل", ""],
      rows.map((r) => [String(r.id), r.source_id, String(r.old), String(r.new),
        Array.isArray(r.explanation) ? r.explanation.join(" · ") : String(r.explanation || ""),
        el("span", {},
          el("button", { class: "primary", onclick: () => act(`/api/reliability/${r.id}/apply`, reload) }, "اعمال"), " ",
          el("button", { class: "danger", onclick: () => act(`/api/reliability/${r.id}/dismiss`, reload) }, "رد"))]))
      : el("p", { class: "muted" }, "پیشنهادی نیست."));
  },
};

async function show(name) {
  document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  say("در حال بارگذاری…");
  try {
    await tabs[name]();
    say("");
  } catch (e) { say(e.message, true); }
}

function logout() {
  sessionStorage.removeItem(KEY);
  $("#tabs").hidden = true;
  $("#logout").hidden = true;
  $("#token").hidden = false;
  view.replaceChildren();
}

$("#login").addEventListener("submit", (ev) => {
  ev.preventDefault();
  sessionStorage.setItem(KEY, $("#token").value.trim());
  $("#token").value = "";
  start();
});
$("#logout").addEventListener("click", logout);
$("#tabs").addEventListener("click", (ev) => {
  const tab = ev.target.closest("button")?.dataset.tab;
  if (tab) show(tab);
});

function start() {
  if (!sessionStorage.getItem(KEY)) return;
  $("#tabs").hidden = false;
  $("#logout").hidden = false;
  $("#token").hidden = true;
  show("status");
}
start();

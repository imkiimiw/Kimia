// In-memory fakes for service unit tests (no database, no sdk).
export const noLog = { info() {}, warn() {}, error() {}, child() { return noLog; } };

export function fakeClock(start = 1_800_000_000) {
  let s = start;
  let ms = start * 1000;
  return { now: () => s, ms: () => ms, advance(sec) { s += sec; ms += sec * 1000; }, advanceMs(n) { ms += n; s = Math.floor(ms / 1000); } };
}

export function fakeSettings(values = {}) {
  const m = new Map(Object.entries({
    'forcejoin.failure_mode': 'open', 'forcejoin.ttl_seconds': 600, 'forcejoin.bypass_staff': true, 'forcejoin.version': 1,
    'forcejoin.seeded': 0, 'broadcast.batch_size': 25, 'telegram.cooldown_until': 0, ...values,
  }));
  return { m, get: async (k) => m.get(k), set: async (_a, k, v) => { m.set(k, v); }, setInternal: async (k, v) => { m.set(k, v); } };
}

/** Alerts with the real throttle rule (send when never sent or `every` seconds passed). */
export function fakeAlerts(clock) {
  const last = new Map();
  const sent = [];
  return {
    sent,
    async owner(key, render, every) {
      const prev = last.get(key);
      if (prev !== undefined && clock.now() - prev < every) return false;
      last.set(key, clock.now());
      sent.push({ key, text: render('fa') });
      return true;
    },
  };
}

export const fakeAudit = () => { const rows = []; return { rows, record: async (...a) => { rows.push(a); } }; };

export function fakeForceJoinRepo(channels) {
  const rows = channels.map((c, i) => ({ id: i + 1, enabled: 1, sort_order: i + 1, last_check_status: 'ok', last_checked_at: 0, username: null, invite_link: null, title: `Ch${i + 1}`, ...c }));
  return {
    rows,
    health: [],
    list: async () => [...rows].sort((a, b) => a.sort_order - b.sort_order),
    listEnabled: async () => rows.filter((r) => r.enabled).sort((a, b) => a.sort_order - b.sort_order),
    get: async (id) => rows.find((r) => r.id === id) || null,
    getByChatId: async (cid) => rows.find((r) => r.chat_id === cid) || null,
    count: async () => rows.length,
    async setHealth(id, status, now) { const r = rows.find((x) => x.id === id); r.last_check_status = status; r.last_checked_at = now; this.health.push([id, status]); },
    async setEnabled(id, flag) { rows.find((r) => r.id === id).enabled = flag ? 1 : 0; return 1; },
    async reorder(ids) { ids.forEach((id, i) => { rows.find((r) => r.id === id).sort_order = i; }); return ids.length; },
    async remove(id) { const i = rows.findIndex((r) => r.id === id); rows.splice(i, 1); return 1; },
    async setInviteLink(id, link) { rows.find((r) => r.id === id).invite_link = link; return 1; },
    async updateMeta() {},
    async insert(c) { if (rows.some((r) => r.chat_id === c.chat_id) || rows.length >= c.max) return null; const r = { id: rows.length + 100, enabled: 1, sort_order: rows.length + 1, last_check_status: 'ok', last_checked_at: c.now, ...c }; rows.push(r); return r; },
    async seedIfEmpty(list) { if (rows.length) return 0; list.forEach((c, i) => rows.push({ id: i + 1, enabled: 1, sort_order: i + 1, last_check_status: 'ok', last_checked_at: 0, invite_link: null, ...c })); return list.length; },
  };
}

export const apiError = (code, description, parameters) => Object.assign(new Error(description), { code, description, parameters });

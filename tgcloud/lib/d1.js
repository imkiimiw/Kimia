// A small statement API (prepare/bind/first/all/run/batch) on top of the tgcloud database's raw SQL
// methods, so the queries in store.js stay plain SQL with positional parameters.
import { db } from 'sdk';

const WRITE = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i;

/** Turns "?" / "?N" placeholders into the named ":pN" parameters the platform's db.run/all/get take. */
function toNamed(sqlText, args) {
  const params = {};
  let next = 0;
  const text = sqlText.replace(/\?(\d+)?/g, (_, n) => {
    const i = n ? Number(n) : (next += 1);
    params[`:p${i}`] = args[i - 1] === undefined ? null : args[i - 1];
    return `:p${i}`;
  });
  return { text, params };
}

function statement(sqlText, args = []) {
  const exec = async (mode) => {
    const { text, params } = toNamed(sqlText, args);
    // Writes (including UPDATE ... RETURNING) always go through db.run; its rows carry RETURNING output.
    if (WRITE.test(text)) {
      const r = await db.run(text, params);
      const rows = r.rows || [];
      if (mode === 'first') return rows[0] ?? null;
      if (mode === 'all') return { results: rows };
      return { results: rows, meta: { changes: r.rowsAffected, last_row_id: r.lastInsertRowid } };
    }
    if (mode === 'first') return (await db.get(text, params)) ?? null;
    const rows = await db.all(text, params);
    return mode === 'all' ? { results: rows } : { results: rows, meta: { changes: 0, last_row_id: 0 } };
  };
  return {
    bind: (...values) => statement(sqlText, values),
    first: () => exec('first'),
    all: () => exec('all'),
    run: () => exec('run'),
  };
}

export const d1 = {
  prepare: (sqlText) => statement(sqlText),
  // Sequential, not a transaction: callers only batch independent statements.
  batch: async (statements) => {
    const out = [];
    for (const s of statements) out.push(await s.run());
    return out;
  },
};

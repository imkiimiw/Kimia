// Local stand-in for `sdk/db` on node:sqlite: the `sql` tag, the schema DSL (enough to create the
// tables the way `tgcloud migrate` would) and raw db.run / db.all / db.get / db.values.
// It mimics what the platform refused when measured (docs/PLATFORM_NOTES.md): transactions,
// TEMP/virtual tables, PRAGMA, multi-statement strings and sqlite_version() throw here too.
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

class Sql {
  constructor(chunks) {
    this.chunks = chunks;
  }

  render(params = {}, counter = { n: 0 }) {
    let text = '';
    for (const c of this.chunks) {
      if ('text' in c) text += c.text;
      else if ('column' in c) text += `"${c.column.name}"`;
      else if ('sql' in c) text += c.sql.render(params, counter).text;
      else {
        counter.n += 1;
        params[`:p${counter.n}`] = c.value;
        text += `:p${counter.n}`;
      }
    }
    return { text, params };
  }
}

export function sql(strings, ...values) {
  const chunks = [];
  strings.forEach((s, i) => {
    chunks.push({ text: s });
    if (i < values.length) {
      const v = values[i];
      if (v instanceof Sql) chunks.push({ sql: v });
      else if (v && v.__column) chunks.push({ column: v });
      else chunks.push({ value: v });
    }
  });
  return new Sql(chunks);
}
sql.raw = (text) => new Sql([{ text }]);

class Column {
  constructor(type, name, opts = {}) {
    this.type = type;
    this.name = name;
    this.opts = opts;
    this.mods = {};
  }
  primaryKey(o = {}) { this.mods.pk = true; this.mods.autoIncrement = !!o.autoIncrement; return this; }
  notNull() { this.mods.notNull = true; return this; }
  unique() { this.mods.unique = true; return this; }
  default(v) { this.mods.def = v; return this; }
  constraint(s) { this.mods.extra = s; return this; }
  deprecated() { this.mods.deprecated = true; return this; }
  references() { throw new Error('Foreign keys are not supported'); }
}
const factory = (type) => (name, opts) => new Column(type, name, opts);
export const integer = factory('INTEGER');
export const text = factory('TEXT');
export const real = factory('REAL');
export const float = real;
export const numeric = factory('NUMERIC');
export const blob = factory('BLOB');
export const boolean = factory('INTEGER');
export const json = factory('TEXT');
export const foreignKey = () => { throw new Error('Foreign keys are not supported'); };

class Index {
  constructor(name, unique) { this.kind = 'index'; this.name = name; this.unique = unique; }
  on(...cols) { this.cols = cols; return this; }
  where(cond) { this.cond = cond; return this; }
}
export const index = (name) => new Index(name, false);
export const uniqueIndex = (name) => new Index(name, true);
export const unique = (name) => new Index(name, true);
export const check = (name, cond) => ({ kind: 'check', name, cond });
export const primaryKey = ({ columns }) => ({ kind: 'pk', columns });

export function table(name, columns, extras) {
  const t = { __table: true, __name: name, __columns: [], __extras: [] };
  const refs = {};
  for (const [key, col] of Object.entries(columns)) {
    col.name = col.name || key;
    if (col.mods.deprecated) continue;
    t.__columns.push(col);
    refs[key] = { __column: true, table: name, name: col.name };
    t[key] = refs[key];
  }
  if (extras) t.__extras = Object.values(extras(refs));
  t.withoutRowid = () => { t.__withoutRowid = true; return t; };
  t.strict = () => t;
  return t;
}

function literal(v) {
  if (v instanceof Sql) return v.render().text;
  if (typeof v === 'number') return String(v);
  if (v === null) return 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}

function ddlText(s, what) {
  const r = s.render();
  if (Object.keys(r.params).length) throw new Error(`${what}: parameters are not allowed in DDL (use literal SQL)`);
  return r.text;
}

/** CREATE statements for every table exported by a schema module. */
export function ddl(schema) {
  const out = [];
  for (const t of Object.values(schema).filter((x) => x && x.__table)) {
    const parts = t.__columns.map((c) => {
      let s = `"${c.name}" ${c.type}`;
      if (c.mods.pk) s += ' PRIMARY KEY' + (c.mods.autoIncrement ? ' AUTOINCREMENT' : '');
      if (c.mods.notNull) s += ' NOT NULL';
      if (c.mods.unique) s += ' UNIQUE';
      if ('def' in c.mods) s += ` DEFAULT ${literal(c.mods.def)}`;
      if (c.mods.extra) s += ` ${c.mods.extra}`;
      return s;
    });
    for (const x of t.__extras) {
      if (x.kind === 'check') parts.push(`CONSTRAINT "${x.name}" CHECK (${ddlText(x.cond, x.name)})`);
      if (x.kind === 'pk') parts.push(`PRIMARY KEY (${x.columns.map((c) => `"${c.name}"`).join(', ')})`);
    }
    out.push(`CREATE TABLE "${t.__name}" (${parts.join(', ')})${t.__withoutRowid ? ' WITHOUT ROWID' : ''}`);
    for (const ix of t.__extras.filter((x) => x.kind === 'index')) {
      const on = ix.cols.map((c) => (c instanceof Sql ? ddlText(c, ix.name) : `"${c.name}"`)).join(', ');
      const where = ix.cond ? ` WHERE ${ddlText(ix.cond, ix.name)}` : '';
      out.push(`CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX "${ix.name}" ON "${t.__name}" (${on})${where}`);
    }
  }
  return out;
}

let database = null;
export const stats = { queries: 0, log: [] };

/** Opens a fresh in-memory database with the tables of `schema` (what `tgcloud migrate` does). */
export function setupDatabase(schema) {
  database = new DatabaseSync(':memory:');
  for (const stmt of ddl(schema)) database.exec(stmt);
  stats.queries = 0;
  stats.log = [];
  return database;
}
export const rawDatabase = () => database;

export const MAX_PARAMS = 4096;
/** measured on the platform (2026-11-06): a statement writing more rows fails, nothing is written */
export const MAX_ROWS_WRITTEN = 10000;
const REFUSED = /^\s*(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|PRAGMA|ATTACH|DETACH|VACUUM)\b|^\s*CREATE\s+(TEMP|TEMPORARY|VIRTUAL)\b/i;

function prepare(query, params) {
  if (!database) throw new Error('setupDatabase() was not called');
  let text = query;
  let bound = params || {};
  if (query instanceof Sql) ({ text, params: bound } = query.render());
  if (REFUSED.test(text)) throw new Error('Failed to prepare query [23] not authorized');
  if (/\bsqlite_version\s*\(/i.test(text)) throw new Error('Failed to prepare query [1] not authorized to use function: sqlite_version');
  const stripped = text.replace(/'(?:[^']|'')*'/g, "''");
  const semi = stripped.indexOf(';');
  if (semi >= 0 && stripped.slice(semi + 1).trim()) throw new Error(`Tail of the query is ignored: ${text.slice(semi + 1).trim().slice(0, 60)}`);
  const clean = {};
  for (const [k, v] of Object.entries(bound)) {
    if (v === undefined) throw new Error(`undefined SQL parameter ${k} in: ${text.replace(/\s+/g, ' ').slice(0, 200)}`);
    if (typeof v === 'boolean') throw new Error(`boolean SQL parameter ${k}: pass 0/1 in: ${text.replace(/\s+/g, ' ').slice(0, 200)}`);
    if (v !== null && typeof v === 'object') throw new Error(`object SQL parameter ${k} in: ${text.replace(/\s+/g, ' ').slice(0, 200)}`);
    clean[k] = v;
  }
  // measured on the platform (2026-11-06): more than 4096 bound parameters in one statement → "Run error"
  if (Object.keys(clean).length > MAX_PARAMS) throw new Error('Run error');
  stats.queries += 1;
  stats.log.push(text.replace(/\s+/g, ' ').trim().slice(0, 120));
  if (PLAN_DIR) recordPlan(text, clean);
  return { stmt: database.prepare(text), params: clean, text };
}

// ---- query-plan recording (scripts/query-review.mjs sets WANGER_QUERY_PLAN_DIR) ----
// Every statement the tests run is explained once; full scans and temp sorts are written to a file
// per test process, which the review script compares with its allowlist.
const PLAN_DIR = process.env.WANGER_QUERY_PLAN_DIR || '';
/** @type {Map<string, {query: string, plan: string[]}>} */
const plans = new Map();
function recordPlan(text, params) {
  const query = text.replace(/\s+/g, ' ').trim();
  if (plans.has(query) || /^\s*(CREATE|DROP|ALTER|EXPLAIN)\b/i.test(query)) return;
  try {
    const rows = database.prepare(`EXPLAIN QUERY PLAN ${text}`).all(params);
    plans.set(query, { query, plan: rows.map((r) => String(r.detail)) });
  } catch (e) {
    plans.set(query, { query, plan: [`(explain failed: ${String(e.message).slice(0, 80)})`] });
  }
}
if (PLAN_DIR) {
  process.on('exit', () => {
    fs.mkdirSync(PLAN_DIR, { recursive: true });
    fs.writeFileSync(`${PLAN_DIR}/${process.pid}.json`, JSON.stringify([...plans.values()]));
  });
}

function reader(text) {
  if (!/^\s*(SELECT|WITH)\b/i.test(text)) throw new Error(`write through a read method: ${text.replace(/\s+/g, ' ').slice(0, 120)}`);
}

const plain = (r) => {
  const o = { ...r };
  for (const k of Object.keys(o)) if (typeof o[k] === 'bigint') o[k] = Number(o[k]);
  return o;
};

/** Runs a write inside a savepoint and undoes it when it wrote more rows than the platform allows. */
function limited(fn) {
  database.exec('SAVEPOINT stmt');
  try {
    const out = fn();
    const n = Number(database.prepare('SELECT changes() AS n').get().n);
    if (n > MAX_ROWS_WRITTEN) throw new Error('Sqlite query rows_written limit exceeded');
    database.exec('RELEASE stmt');
    return out;
  } catch (e) {
    database.exec('ROLLBACK TO stmt');
    database.exec('RELEASE stmt');
    throw e;
  }
}

export const db = {
  async run(query, params) {
    const { stmt, params: p, text } = prepare(query, params);
    if (/\bRETURNING\b/i.test(text)) {
      const rows = limited(() => stmt.all(p).map(plain));
      return { rowsAffected: rows.length, lastInsertRowid: 0, rows };
    }
    const r = limited(() => stmt.run(p));
    return { rowsAffected: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid), rows: [] };
  },
  async all(query, params) {
    const { stmt, params: p, text } = prepare(query, params);
    reader(text);
    return stmt.all(p).map(plain);
  },
  async get(query, params) {
    const { stmt, params: p, text } = prepare(query, params);
    reader(text);
    const r = stmt.get(p);
    return r ? plain(r) : null;
  },
  async values(query, params) {
    const { stmt, params: p, text } = prepare(query, params);
    reader(text);
    return stmt.all(p).map((r) => Object.values(plain(r)));
  },
};
db.sql = sql;
export default db;

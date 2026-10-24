// Local stand-in for `sdk/db`: the `sql` tag, the schema DSL (enough to create the tables the way
// `tgcloud migrate` would) and the raw db.run / db.all / db.get methods, backed by node:sqlite.
import { DatabaseSync } from 'node:sqlite';

// ---------- sql`…` ----------

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

// ---------- schema DSL ----------

class Column {
  constructor(type, name, opts = {}) {
    this.type = type;
    this.name = name;
    this.opts = opts;
    this.mods = {};
  }
  primaryKey(o = {}) {
    this.mods.pk = true;
    this.mods.autoIncrement = !!o.autoIncrement;
    return this;
  }
  notNull() {
    this.mods.notNull = true;
    return this;
  }
  unique() {
    this.mods.unique = true;
    return this;
  }
  default(v) {
    this.mods.def = v;
    return this;
  }
  references() {
    throw new Error('Foreign keys are not supported');
  }
}

const factory = (type) => (name, opts) => new Column(type, name, opts);
export const integer = factory('INTEGER');
export const text = factory('TEXT');
export const real = factory('REAL');

class Index {
  constructor(name, unique) {
    this.name = name;
    this.unique = unique;
  }
  on(...cols) {
    this.cols = cols;
    return this;
  }
  where(cond) {
    this.cond = cond;
    return this;
  }
}
export const index = (name) => new Index(name, false);
export const uniqueIndex = (name) => new Index(name, true);

export function table(name, columns, extras) {
  const t = { __table: true, name, columns: [], indexes: [] };
  const refs = {};
  for (const [key, col] of Object.entries(columns)) {
    col.name = col.name || key;
    t.columns.push(col);
    refs[key] = { __column: true, table: name, name: col.name };
    t[key] = refs[key];
  }
  if (extras) t.indexes = Object.values(extras(refs));
  return t;
}

function literal(v) {
  if (v instanceof Sql) return v.render().text;
  if (typeof v === 'number') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** CREATE statements for every table exported by a schema module. */
export function ddl(schema) {
  const out = [];
  for (const t of Object.values(schema).filter((x) => x && x.__table)) {
    const cols = t.columns.map((c) => {
      let s = `"${c.name}" ${c.type}`;
      if (c.mods.pk) s += ' PRIMARY KEY' + (c.mods.autoIncrement ? ' AUTOINCREMENT' : '');
      if (c.mods.notNull) s += ' NOT NULL';
      if (c.mods.unique) s += ' UNIQUE';
      if ('def' in c.mods) s += ` DEFAULT ${literal(c.mods.def)}`;
      return s;
    });
    out.push(`CREATE TABLE "${t.name}" (${cols.join(', ')})`);
    for (const ix of t.indexes) {
      const on = ix.cols.map((c) => `"${c.name}"`).join(', ');
      const where = ix.cond ? ` WHERE ${ix.cond.render().text}` : '';
      if (ix.cond && Object.keys(ix.cond.render().params).length) throw new Error(`Index ${ix.name}: parameters are not allowed in DDL`);
      out.push(`CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX "${ix.name}" ON "${t.name}" (${on})${where}`);
    }
  }
  return out;
}

// ---------- db ----------

let database = null;

/** Creates a fresh in-memory database with the tables of `schema` (what `tgcloud migrate` does). */
export function setupDatabase(schema) {
  database = new DatabaseSync(':memory:');
  for (const stmt of ddl(schema)) database.exec(stmt);
  return database;
}

function prepare(query, params) {
  if (!database) throw new Error('setupDatabase() was not called');
  let text = query;
  let bound = params || {};
  if (query instanceof Sql) ({ text, params: bound } = query.render());
  // The platform binds booleans as 0/1 and undefined as NULL.
  const clean = {};
  for (const [k, v] of Object.entries(bound)) clean[k] = v === undefined ? null : typeof v === 'boolean' ? Number(v) : v;
  return { stmt: database.prepare(text), params: clean, text };
}

export const db = {
  async run(query, params) {
    const { stmt, params: p, text } = prepare(query, params);
    if (/\bRETURNING\b/i.test(text)) {
      const rows = stmt.all(p).map((r) => ({ ...r }));
      return { rowsAffected: rows.length, lastInsertRowid: 0, rows };
    }
    const r = stmt.run(p);
    return { rowsAffected: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid), rows: [] };
  },
  async all(query, params) {
    const { stmt, params: p } = prepare(query, params);
    return stmt.all(p).map((r) => ({ ...r }));
  },
  async get(query, params) {
    const { stmt, params: p } = prepare(query, params);
    const r = stmt.get(p);
    return r ? { ...r } : null;
  },
};

export default db;

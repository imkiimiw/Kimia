// Local stand-in for `sdk/db`: the `sql` tag, the schema DSL (enough to create the tables the way
// `tgcloud migrate` would) and the raw db.run / db.all / db.get / db.values methods, on node:sqlite.
// Stricter than needed on purpose: an `undefined` parameter or a foreign key throws.
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
export const foreignKey = () => {
  throw new Error('Foreign keys are not supported');
};

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
  // Like Drizzle, the table's own fields stay out of the way of column names.
  const t = { __table: true, __name: name, __columns: [], __indexes: [] };
  const refs = {};
  for (const [key, col] of Object.entries(columns)) {
    col.name = col.name || key;
    t.__columns.push(col);
    refs[key] = { __column: true, table: name, name: col.name };
    t[key] = refs[key];
  }
  if (extras) t.__indexes = Object.values(extras(refs));
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
    const cols = t.__columns.map((c) => {
      let s = `"${c.name}" ${c.type}`;
      if (c.mods.pk) s += ' PRIMARY KEY' + (c.mods.autoIncrement ? ' AUTOINCREMENT' : '');
      if (c.mods.notNull) s += ' NOT NULL';
      if (c.mods.unique) s += ' UNIQUE';
      if ('def' in c.mods) s += ` DEFAULT ${literal(c.mods.def)}`;
      return s;
    });
    out.push(`CREATE TABLE "${t.__name}" (${cols.join(', ')})`);
    for (const ix of t.__indexes) {
      const on = ix.cols.map((c) => `"${c.name}"`).join(', ');
      let where = '';
      if (ix.cond) {
        const r = ix.cond.render();
        if (Object.keys(r.params).length) throw new Error(`Index ${ix.name}: parameters are not allowed in DDL`);
        where = ` WHERE ${r.text}`;
      }
      out.push(`CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX "${ix.name}" ON "${t.__name}" (${on})${where}`);
    }
  }
  return out;
}

// ---------- db ----------

let database = null;
export const stats = { queries: 0 };
/** Failure injection (test/load.mjs): the query numbered `failAt` (counted like stats.queries) throws once. */
export const faults = { failAt: 0 };

/**
 * Opens the database and creates the tables of `schema` (what `tgcloud migrate` does).
 * In memory by default; with a file path the tables are created once and the data persists
 * between processes (used by test/cloud/local-cli.mjs).
 */
export function setupDatabase(schema, file = ':memory:') {
  database = new DatabaseSync(file);
  const exists = database.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get().n > 0;
  if (!exists) for (const stmt of ddl(schema)) database.exec(stmt);
  return database;
}

export const rawDatabase = () => database;

function prepare(query, params) {
  if (!database) throw new Error('setupDatabase() was not called');
  let text = query;
  let bound = params || {};
  if (query instanceof Sql) ({ text, params: bound } = query.render());
  const clean = {};
  for (const [k, v] of Object.entries(bound)) {
    if (v === undefined) throw new Error(`undefined SQL parameter ${k} in: ${text.replace(/\s+/g, ' ').slice(0, 200)}`);
    if (typeof v === 'boolean') throw new Error(`boolean SQL parameter ${k}: pass 0/1 in: ${text.replace(/\s+/g, ' ').slice(0, 200)}`);
    if (v !== null && typeof v === 'object') throw new Error(`object SQL parameter ${k} in: ${text.replace(/\s+/g, ' ').slice(0, 200)}`);
    clean[k] = v;
  }
  stats.queries += 1;
  if (faults.failAt && stats.queries === faults.failAt) {
    faults.failAt = 0;
    throw new Error('Sqlite query failed: injected failure');
  }
  return { stmt: database.prepare(text), params: clean, text };
}

// db.all / db.get / db.values are for reads only (the platform picks the mode by method).
function reader(text) {
  if (!/^\s*(SELECT|WITH)\b/i.test(text)) throw new Error(`write through a read method: ${text.replace(/\s+/g, ' ').slice(0, 120)}`);
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
    const { stmt, params: p, text } = prepare(query, params);
    reader(text);
    return stmt.all(p).map((r) => ({ ...r }));
  },
  async get(query, params) {
    const { stmt, params: p, text } = prepare(query, params);
    reader(text);
    const r = stmt.get(p);
    return r ? { ...r } : null;
  },
  async values(query, params) {
    const { stmt, params: p, text } = prepare(query, params);
    reader(text);
    stmt.setReturnArrays?.(true);
    return stmt.all(p).map((r) => (Array.isArray(r) ? r : Object.values(r)));
  },
};

export default db;

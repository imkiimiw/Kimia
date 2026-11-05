// Structured logging: one JSON line per event via console (pure).
// Only whitelisted fields are written, so raw updates, message texts and tokens can't leak in.

const FIELDS = ['update_id', 'user_id', 'chat_id', 'track_id', 'channel_id', 'publication_id', 'broadcast_id', 'handler', 'trigger', 'status', 'count', 'duration_ms', 'error_code', 'error'];

/**
 * @param {Record<string, any>} [base] fields added to every line
 * @param {{log: Function, warn: Function, error: Function}} [sink]
 */
export function createLogger(base = {}, sink = console) {
  /** @param {'info'|'warn'|'error'} level @param {string} event @param {Record<string, any>} [fields] */
  function emit(level, event, fields = {}) {
    /** @type {Record<string, any>} */
    const line = { ts: new Date().toISOString(), level, event };
    for (const k of FIELDS) {
      const v = k in fields ? fields[k] : base[k];
      if (v === undefined || v === null) continue;
      line[k] = typeof v === 'string' ? v.slice(0, 300) : v;
    }
    const text = JSON.stringify(line);
    if (level === 'error') sink.error(text);
    else if (level === 'warn') sink.warn(text);
    else sink.log(text);
  }
  return {
    /** @param {string} e @param {Record<string, any>} [f] */
    info: (e, f) => emit('info', e, f),
    /** @param {string} e @param {Record<string, any>} [f] */
    warn: (e, f) => emit('warn', e, f),
    /** @param {string} e @param {Record<string, any>} [f] */
    error: (e, f) => emit('error', e, f),
    /** @param {Record<string, any>} more */
    child: (more) => createLogger({ ...base, ...more }, sink),
  };
}

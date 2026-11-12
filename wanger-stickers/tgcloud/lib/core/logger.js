/**
 * Structured logging: one JSON line per event via console (pure). Only whitelisted fields are
 * written, so raw updates, message texts, file bytes and tokens can't leak in.
 * (Adapted from wanger-music lib/core/logger.js.)
 */
const FIELDS = ['update_id', 'user_id', 'chat_id', 'pack_id', 'post_id', 'broadcast_id', 'handler', 'status', 'count', 'duration_ms', 'error_code', 'error'];

export function createLogger(base = {}, sink = console) {
  function emit(level, event, fields = {}) {
    const line = { level, event };
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
    info: (e, f) => emit('info', e, f),
    warn: (e, f) => emit('warn', e, f),
    error: (e, f) => emit('error', e, f),
  };
}

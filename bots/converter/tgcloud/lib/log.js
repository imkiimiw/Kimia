// Structured JSON logs (spec §11): one line per event, a fixed set of fields. Never tokens, keys,
// file contents, OCR text or file names. Logs are only visible in `tgcloud run` output (the platform
// has no log viewer for webhook invocations), so errors also go to the `errors` table.
const FIELDS = ['update_id', 'job_id', 'job_code', 'user_id', 'operation', 'input_type', 'output_type', 'input_size', 'output_size', 'duration_ms', 'status', 'error_code', 'kind', 'view'];

function line(level, msg, data) {
  const out = { level, msg };
  if (data) for (const k of FIELDS) if (data[k] !== undefined && data[k] !== null) out[k] = data[k];
  return JSON.stringify(out);
}

export const info = (msg, data) => console.log(line('INFO', msg, data));
export const warn = (msg, data) => console.warn(line('WARNING', msg, data));
export const error = (msg, data) => console.error(line('ERROR', msg, data));

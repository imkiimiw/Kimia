// Globals the platform's V8 isolate provides (measured 2026-11-05, docs/PLATFORM_NOTES.md).
// Deliberately NOT declared: setTimeout, setInterval, URL, Buffer, process, performance.
declare var console: {
  log(...args: any[]): void;
  info(...args: any[]): void;
  warn(...args: any[]): void;
  error(...args: any[]): void;
};

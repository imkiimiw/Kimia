// Globals the platform's V8 isolate provides (measured 2026-11-05, docs/PLATFORM_NOTES.md).
// Deliberately NOT declared: setTimeout, setInterval, URL, Buffer, process, performance.
declare var console: {
  log(...args: any[]): void;
  info(...args: any[]): void;
  warn(...args: any[]): void;
  error(...args: any[]): void;
};
// Measured available (PLATFORM_NOTES "Globals"): used by backups to turn JSON into upload bytes.
declare class TextEncoder { encode(s?: string): Uint8Array; }
declare class TextDecoder { constructor(label?: string); decode(b?: Uint8Array): string; }

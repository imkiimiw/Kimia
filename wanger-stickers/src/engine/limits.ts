// The engine reads the SAME limits object as the server (tgcloud/lib/core/limits.js is a pure
// module, so Vite can bundle it). One source of truth instead of two copies plus a parity test.
export { TELEGRAM, WHATSAPP, PLATFORM, SIZE_TARGETING, CHECKED_ON, SOURCES, LIMITS } from '../../tgcloud/lib/core/limits.js';

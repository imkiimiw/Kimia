/*
 * The bot's languages. To add one:
 *   1. copy en.js to <code>.js (an IETF language code, e.g. ru.js), translate the values,
 *      keep the keys and the {placeholders};
 *   2. import it below and add it to LOCALES (the order is the order of the language buttons);
 *   3. npm test (checks every key and placeholder), then deploy and send /setup as the owner.
 * A locale may set _digits (its ten digits) and _plural (n) => 'one' | 'few' | 'many' | 'other'.
 */
import fa from './fa.js';
import en from './en.js';

export const DEFAULT_LANG = 'fa';
export const LOCALES = { fa, en };

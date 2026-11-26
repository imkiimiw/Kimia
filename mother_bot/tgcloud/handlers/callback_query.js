// A button press: lib/router.js onCallback (every press is answered).
import { onCallback } from '../lib/router.js';

export default async function (query) {
  try {
    return await onCallback(query);
  } catch (err) {
    console.error('callback_query handler failed:', err);
    return { error: true };
  }
}

// The sender posted one of the inline results: the draft becomes a real whisper.
// Needs inline feedback switched on in @BotFather (/setinlinefeedback).
import { onChosenInlineResult } from '../lib/router.js';

export default async function (chosen) {
  try {
    return await onChosenInlineResult(chosen);
  } catch (err) {
    console.error('chosen_inline_result handler failed:', err);
    return { error: true };
  }
}

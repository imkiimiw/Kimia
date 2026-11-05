// handlers/chosen_inline_result — a user sent an inline result: count the play (needs /setinlinefeedback).
import { runHandler } from '../lib/core/boundary.js';
import { onChosenInlineResult } from '../lib/bot/router.js';

export default function (result, ctx) {
  return runHandler('chosen_inline_result', result, ctx, (app) => onChosenInlineResult(app, result));
}

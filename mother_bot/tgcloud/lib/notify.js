// Messages for the development team: alerts, error logs, new tickets, abuse flags. They go to the log
// chat when the owner picked one (/admin → ⚙️ → log chat: a private group or channel), else privately
// to every team member (the owner and role > 0).
import { kvGet, teamIds } from './store.js';
import { send } from './tg.js';

export async function logChat() {
  const v = await kvGet('log_chat');
  return v ? Number(v) : null;
}

/** Sends to the log chat, or to each team member. Returns how many messages went out. */
export async function notifyTeam(ctx, view, text, kb = null, { silent = false } = {}) {
  const chat = await logChat();
  if (chat) return (await send(ctx, view, text, kb, chat, { silent })) ? 1 : 0;
  let n = 0;
  for (const id of await teamIds()) if (await send(ctx, view, text, kb, id, { silent })) n += 1;
  return n;
}

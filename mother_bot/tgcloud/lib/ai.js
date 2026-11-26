// Optional AI (Google Gemini, free tier) for the assistant and the report triage. The key lives in the
// database (kv secret:gemini, set with the owner's /aikey — the message is deleted at once), never in
// code. Without a key, or when the quota is used up, everything works with the keyword engine
// (lib/catalog.js search); the AI only makes answers more natural. Every answer is grounded in the
// catalog the team wrote: the prompt forbids inventing features.
// Privacy: the user's question (never their id or name) is sent to Google; /help says so.
import { db, fetch } from 'sdk';
import { sql } from 'sdk/db';
import {
  AI_DAILY, AI_MODEL, AI_PAUSE_SEC, AI_PER_USER_DAY, AI_URL,
} from './config.js';
import { bump, kvGet, setKv } from './store.js';
import { localDay, nowSec, truncate } from './util.js';

const KEY = 'secret:gemini';

export const getKey = () => kvGet(KEY);
export const setKey = (key) => setKv(KEY, key);

/** Checks a key with a free metadata request: 'ok' | 'rejected' | 'unknown'. */
export async function checkKey(key) {
  try {
    const res = await fetch(`${AI_URL}/${AI_MODEL}`, { headers: { 'x-goog-api-key': key } });
    if (res.ok) return 'ok';
    return [400, 401, 403].includes(res.status) ? 'rejected' : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** The key if AI may be used now for this user (daily caps, pause after a 429), else null. */
export async function ready(user) {
  if ((await kvGet('ai_on')) === '0') return null;
  const key = await getKey();
  if (!key) return null;
  const now = nowSec();
  if (Number(await kvGet('ai_pause')) > now) return null;
  const day = localDay(now);
  if (Number(await kvGet(`ai_day_${day}`)) >= AI_DAILY) return null;
  if (user && Number(user.ai_day) === day && Number(user.ai_count) >= AI_PER_USER_DAY) return null;
  return key;
}

async function count(user) {
  const day = localDay();
  await bump(`ai_day_${day}`);
  if (user) {
    await db.run(sql`UPDATE users SET ai_count = CASE WHEN ai_day = ${day} THEN ai_count + 1 ELSE 1 END, ai_day = ${day} WHERE user_id = ${user.user_id}`);
  }
}

/**
 * One JSON-mode call. `schema` is a Gemini responseSchema. Returns the parsed object or null
 * (no AI this time: network, quota, safety block, bad JSON).
 */
export async function generate(key, user, prompt, schema, { temperature = 0.3 } = {}) {
  await count(user);
  let res;
  let body;
  try {
    res = await fetch(`${AI_URL}/${AI_MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature, responseMimeType: 'application/json', responseSchema: schema },
      }),
    });
    body = await res.json();
  } catch (err) {
    console.warn(`AI: request failed: ${truncate(String((err && err.message) || err), 120)}`);
    return null;
  }
  if (res.status === 429) {
    await setKv('ai_pause', nowSec() + AI_PAUSE_SEC);
    return null;
  }
  const cand = body && body.candidates && body.candidates[0];
  if (!res.ok || !cand || !cand.content || !cand.content.parts) {
    console.warn(`AI: ${res.status} ${body && body.error ? truncate(String(body.error.message), 120) : 'no answer'}`);
    return null;
  }
  try {
    return JSON.parse(cand.content.parts.map((p) => p.text || '').join(''));
  } catch {
    return null;
  }
}

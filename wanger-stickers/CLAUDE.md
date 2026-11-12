@AGENTS.md

# Wanger Stickers — working notes for Claude

Read `docs/BRIEF.md` (the owner's brief; §1 rules apply to every session), then
`docs/SPIKE_REPORT.md` and `docs/DECISIONS.md`. Work only on the phase Kimi names. At the end of a
phase: tests green, docs updated (CHANGELOG, DECISIONS, SPIKE_REPORT/QA as needed), a short report in
Persian (what was built, how to test, known gaps, decisions needed), then STOP.

## Owner's standing instruction (2026-11-12) — keep until the last phase

"فاز سوم رو شروع کن و بقیه فاز ها رو هم تا ته همین الان تایید میکنم فقط پایان هر فاز بهم گزارش بده"
(start Phase 3; I approve all the remaining phases to the end right now; just report to me at the
end of each phase). → Work through Phases 3, 4, 5 (and 6 only if it stays inside this repository
and needs no paid account) in order without asking; deploy each finished phase
(`npm run tg -- migrate --local --safe`, then `npm run deploy`); after each phase send Kimi a short
report in Persian. Still never: destructive migrations (drops, type changes), `push --force`,
real broadcasts or channel posts, BotFather changes, anything that costs money or needs Kimi's
accounts (Apple developer account, payment provider setup) — list those in the report instead.

Current state: **Phases 0–2 built; 0–1 deployed; Phase 2 being deployed; Phase 3 in progress.**
Device checks (docs/QA.md) are Kimi's to run on her phones.

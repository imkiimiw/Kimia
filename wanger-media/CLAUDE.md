@AGENTS.md

# Wanger Media — working notes for Claude

Read `docs/PROGRESS.md` first, then `docs/BRIEF.md` (the owner's brief; its §2 rules apply to every
session). Work only on the phase the owner names; at the end of a phase: tests green, docs updated,
summary, then STOP. Talk to the owner in Persian; code, comments, commits and docs in English.

## Owner's standing instruction (2026-11-06) — keep until the last phase

"Do all phases to the end, one by one. Just give me a report of each phase when it is done. I approve
all of them, until the very end." → Work through every remaining phase in order without asking;
deploy each finished phase (`npm run tg -- migrate --local --safe`, then `npm run tg -- push`) without
asking; after each phase send the owner a short report in Persian. Still never: destructive
migrations (drops), `push --force`, or anything that costs money or needs the owner's accounts —
those remain the owner's (list them in the report instead).

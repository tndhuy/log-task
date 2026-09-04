# eoffice platform

Writes through the bundled Playwright scripts. Creating a task and reporting
its progress are separate external mutations and require separate approvals.

## Required `params` in projects.json

- `defaultAssignor` — visible name of the current eOffice assignor.
- `defaultAssignee` — visible assignee name.
- `defaultFollower` — visible follower name.
- `defaultCollaborator` — visible collaborator name. The recorded form combines
  follower and collaborator, so these two values must match.

Never infer or substitute a person. Stop when a value is missing or when its
visible name matches zero or multiple eOffice options.

## One-time setup

1. Run `npm install`.
2. Run `npx playwright install chromium`.
3. Log into `https://eoffice.novagroup.vn` in Chrome.
4. Run `node scripts/eoffice-session.mjs` to capture the existing session.

The checked-in `eoffice-form-map.json` is based on the 2026-08-26 Record &
Replay capture and contains no account secrets. If eOffice changes its form,
run `node scripts/discover-eoffice-form.mjs create-task` and then
`node scripts/discover-eoffice-form.mjs report-progress`; inspect the printed
semantic controls and update the map. Discovery never submits either form.

## Draft format

Use the same grouping and fields as `manual.md`. Also show the resolved eOffice
project, assignor, assignee, follower, collaborator, start/end dates, report
date, report description, and completion status. Only a clearly `Done`
mutation task may enter either the creation or reporting batch. A `Partial`,
investigation-only, review, or verification-only item must not be created or
reported by this workflow.

## Write procedure

1. Convert each approved creation draft to JSON with `project`, `taskName`,
   optional `taskCode`, `assignor`, `assignee`, `follower`, `collaborator`,
   `startDate`, and `endDate`. Resolve people from the project's `params`.
2. Run `node scripts/eoffice-write.mjs create-task --dry-run <tasks.json>`.
   Show the complete preview and obtain explicit approval immediately before
   the real create operation.
3. Run `node scripts/eoffice-write.mjs create-task <tasks.json>`. Parse the last
   output line as `{ taskName, submitted, externalLink?, error? }[]`. Stop and
   report failures; do not retry with altered data.
4. Build a separate report JSON containing only completed tasks, with
   `project`, `taskName`, `reportDate`, `progress: "100"`, and `description`.
5. Run `node scripts/eoffice-write.mjs report-progress --dry-run <reports.json>`.
   Show this separate preview and obtain a second explicit approval. Creation
   approval does not authorize reporting.
6. Run `node scripts/eoffice-write.mjs report-progress <reports.json>`. Treat a
   report as successful only when the script verifies both `100%` and
   `Evaluating`.
7. Append a task to the ledger only after all required external steps for that
   task succeeded. Preserve any returned `externalLink`; do not invent one when
   eOffice exposes no stable link.

Exit codes: `1` bad CLI usage, `3` missing/expired session, `4` invalid input,
form map, or local setup, `5` submit/verification failure, and `6` missing or
ambiguous people. For exit `3`, log into eOffice in Chrome and rerun
`eoffice-session.mjs`. Never retry a write automatically.

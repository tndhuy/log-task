# Request: correct actual dates on production (hold at DOING, then report)

Status: ready for implementation · Builds on branch `feat/eoffice-production-support` (get, delete,
links, people check, `set-dates`). Evidence: [`eoffice-api-production-findings.md`](eoffice-api-production-findings.md)
F2 and **F8**, open points O6–O7. This file is the work order; the findings file is the evidence.
When they disagree, stop and ask.

## Why

On 2026-10-19 the CLI created seven One Nova tasks (2135342–2135360) whose evidence dates were
07/10–15/10. Every one came out with actual dates 19/10, the run date (F2). Fixing them took
hand-written calls:

- the integration API cannot set a past actual start: `update start=...` clears it to `null` in
  every accepted format, in DOING and in REVIEW (F8);
- the session route (`create --apply --session-from`) moves the task to DOING, which stamps
  `start` with the run date, then reports; the report is refused because its date is before
  `start` ("Ngày bắt đầu không được lớn hơn ngày kết thúc");
- what worked, on all eight tasks: `update` DOING (API) → the owner edits the actual start in the
  UI → progress report dated the evidence end date (session). The report sets `end` to its date,
  status REVIEW, 100 %, with a report record.

The skill must follow that sequence itself instead of stamping the run date and leaving the user
to discover it.

## Constraints

Same as `request-eoffice-production-support.md`: Node standard library only, dry-run plus
`--confirm-host` (and `--allow-production` off UAT) for anything that writes, HTTP mocked through
`fetchImpl` in tests, no real host in tests, tokens and cookies never printed or stored,
conventional commits (at most 6 for this request), `npm test` green before each.

## Work items

### W1. `create --hold-at doing` — `eoffice-api-write.mjs`

- New option on `create --apply`: `--hold-at doing`. Per task: `insert` → people check (as today)
  → one `update status="Đang thực hiện"` → `getItem(..., { raw: true })`. No report, no REVIEW update,
  no session needed.
- Result per task: `{ submitted: true, externalId, link, status: "DOING", hold: "doing",
  reportItem: { id, start, end, note } }`, where `start`/`end` are the task's evidence dates
  (`start ?? startPlan`, `end ?? endPlan`) and `note` is the plan's `note` (`task.note ?? summary`). `submitted: true`
  means "created with correct people" so the skill ledgers it (with `stage`, see W4).
- After the per-task results, the CLI prints nothing else; the skill collects the `reportItem`s.
- Children: same rule as today (no report on a task with children or on a child): those get the
  REVIEW update as now and no `reportItem`; their dates stay the run date and the result says
  `datesFromRun: true`.
- `--hold-at` with a value other than `doing`, or on `--dry-run`: usage error, exit 2.
- Without `--hold-at`, `create` is unchanged (the verified UAT flow).
- Acceptance: CLI tests that `--hold-at doing` records exactly `insert`, `item`, `update` DOING,
  `item` per flat task (no `progress`, no REVIEW `update`), returns `reportItem`; a parent with
  children gets REVIEW for both; people-check failure still stops before the DOING update.

### W2. `report` command — `eoffice-api-write.mjs`

```
node eoffice-api-write.mjs report --dry-run --project-id <rawId> --items <items.json>
node eoffice-api-write.mjs report --apply --confirm-host <host> [--allow-production] --session-from brave|chrome --project-id <rawId> --items <items.json>
```

- `items.json`: `[{ "id": 2135345, "start": "2026-10-09", "end": "2026-10-14", "note": "..." }]`
  (the `reportItem`s from W1; `note` defaults to the task title).
- Classification from `getItem(..., { raw: true })`, dry-run and apply alike:
  - `absent` — `Post not found`; `refused` — `project_id` ≠ `--project-id`;
  - `done` — status REVIEW (or later), `percent` 100, actual `start`/`end` equal the item's: nothing
    to do (a task is never reported twice; a REVIEW task refuses a report anyway);
  - `waiting` — status DOING but actual `start` ≠ item `start` (the UI edit has not been made or
    saved). Output the `link` and the expected start;
  - `wrong status` — anything else (PENDING, REVIEW with other dates, ...), with the current status
    and dates; never moved by this command;
  - `ready` — status DOING, actual `start` = item `start`, item `end` ≥ `start`.
- Apply: same host gate as `create`; exit 2 before any call if any item is `absent` or `refused`.
  Then, for each `ready` item in order: `reportProgress({ taskId, date: end, percent: 100, note })`,
  wait `EOFFICE_SETTLE_MS`, `getItem`; expect REVIEW, 100, `start` and `end` as the item →
  `reported`, else `mismatch` with the read values, and stop (later items `not attempted`).
  `waiting` and `wrong status` items are reported, not retried, and do not stop the others.
- Output: JSON array `{ id, title, link, result, expected: { start, end }, actual: { status, percent,
  start, end }, reason?, error? }`. Exit 0 when every item is `reported` or `done`; 1 when any is
  `waiting`, `wrong status`, `mismatch` or `not attempted`; 2 for usage and gate errors.
- Never sends `update` (no status change, no dates): F8 shows both clear the actual start.
- Acceptance: CLI tests for each class; a rerun after a partial run reports only the remaining
  `ready` items (the earlier ones are `done`); report refusal text
  "Ngày bắt đầu không được lớn hơn ngày kết thúc" → `error` plus the hint "actual start is after
  the report date; edit the actual start in the UI"; no `update` call is ever recorded; bad JSON
  or a missing field → exit 2.

### W3. Guard against date-clearing `update` calls — `lib/eoffice-api.mjs`

- `updateTask` accepts only `{ id, status }` and throws on any other key (a caller passing
  `start`/`end` would clear the actual start, F8).
- Acceptance: unit test that `updateTask(client, { id, status, start })` throws without a request.

### W4. Skill procedure — `references/eoffice-api.md`, `SKILL.md`

- Production (host not in the UAT allowlist) with `rules.dates.actualFromPlan: true`: Step 7 runs
  `create --apply --hold-at doing`, then:
  1. ledger each `submitted: true` result with `stage: "doing"`;
  2. save the `reportItem`s to the run's temp `items.json` and show the user a table:
     link, title, actual start to set in the UI; ask them to edit and save each one and not to
     press report in the UI;
  3. after the user confirms, `report --dry-run`, then `report --apply`; on `waiting` items, show
     them again and repeat only after the user confirms;
  4. set `stage: "reported"` and `reportedAt` on each `reported`/`done` entry (temp file + rename).
- UAT keeps the current flow.
- A later run that finds ledger entries with `stage: "doing"` lists them first and offers
  `report` for them (the `items.json` is rebuilt from the ledger: `externalId` plus the dates
  stored on the entry — so W4.1 also stores `start` and `end` on the entry).
- The final report lists every task with its `link`, status, and actual dates as read back.

### W5. Docs and checklist

- `references/eoffice-api.md`: replace "Correcting actual dates" with the F8 table summary, the
  hold → UI edit → report sequence, `report` usage, and the note that `set-dates` is unverified
  (O6) and is not part of the production flow until O6 is answered.
- `docs/uat-checklist.md`, Production section: tick F8 items (DOING stamps start; `update start`
  clears it; report sets end; report refused before start; UI edit kept) and add O6, O7 unchecked.
- `README.md`: one line for `report` and `--hold-at doing`.

## Out of scope

- Automating the UI edit. If O6 shows that `set-dates` sets the actual start of a DOING task,
  a follow-up request may add `report --set-start` to call it before reporting.
- Changing the UAT flow, the people check, `get`, `delete`.
- Any retry of a refused report with an altered date.

## Verification before merge

1. `npm test` green.
2. On UAT, with a UAT token and session: `create --apply --hold-at doing` of one task dated in the
   past → DOING with `start` = run date; edit the start in the UI; `report --dry-run` shows
   `ready`; `report --apply` → `reported` with the evidence dates; rerun → `done`.
3. Production only with the owner's explicit instruction: `report --dry-run --project-id 3869`
   with the eight 2026-10-19 tasks (2135342, 2135345, 2135348, 2135351, 2135354, 2135357,
   2135360, 2133680) → all `done`. Read-only.

## Suggested commits

1. `feat(eoffice): refuse date fields in status updates` (W3)
2. `feat(eoffice): hold created tasks at DOING for a later report` (W1)
3. `feat(eoffice): add report command with start-date preflight` (W2)
4. `docs(eoffice): document the production date sequence and report flow` (W4, W5)

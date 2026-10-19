# Request: eOffice production support (delete, get, task links, people check)

Status: ready for implementation · Source of truth for behaviour:
[`eoffice-api-production-findings.md`](eoffice-api-production-findings.md) (F1–F7, R1–R3, O2–O5).
This file is the work order; the findings file is the evidence. When they disagree, stop and ask.

## Why

The first production run (2026-10-16, `eoffice.novagroup.vn`, project 3869) created four tasks.
Three came out with no owner and no assignee, because production resolves people by display
name while the skill sends usernames (F1); the CLI reported all of them as `submitted: true`.
Cleaning up needed hand-written API calls, because the skill cannot delete or look up a task
by ID, and its output gives no link to open the task.

## Constraints (from CONTRIBUTING.md)

- Node standard library only; no npm dependencies. Node ≥ 22.13.
- Anything that writes to eOffice has a dry-run mode and needs `--confirm-host`; a non-UAT host
  also needs `--allow-production`. Tokens and cookies are never printed or stored.
- Tests mirror `scripts/` under `tests/`, run with `npm test`, and mock HTTP through the
  `fetchImpl` option of `createClient` (see `fakeFetch` in `tests/scripts/lib/eoffice-api.test.mjs`).
  No test calls a real eOffice host.
- Only `skills/log-task/` ships; design notes stay in `docs/`.
- Conventional commits, at most 10 for this request, `npm test` green before each.

## Work items

### W1. `item` client function — `lib/eoffice-api.mjs`

- Add `getItem(client, { id, raw = false })` → `GET /api/work/normal/item?ID=<id>`
  (+ `field_raws=allfield` when `raw`). Returns `data`, or `null` when the server answers
  `Post not found` (F7). Any other error propagates.
- Acceptance: unit tests for found, `Post not found` → `null`, other API error → throws, `raw` adds
  the parameter, token never appears in a thrown message.

### W2. Task link — `lib/eoffice-api.mjs` + every CLI output

- Add `taskLink(id, { baseUrl, template })`: replaces `{origin}` (origin of `EOFFICE_BASE_URL`)
  and `{id}`; returns `undefined` when `template` is empty.
- Template source: `EOFFICE_TASK_URL_TEMPLATE` only. Production value:
  `{origin}/work-normal-normal/view?ID={id}`.
- Add `link` to every result that has an ID: `create` (`externalId`, `duplicate.id`), `get`, `delete`.
  When the template is unset, omit `link` and print one hint line to stderr per run.
- `assets/env.example` and `lib/init.mjs`: add the variable as a commented example.
- Acceptance: unit tests for the substitution and the unset case; CLI test that `create --apply`
  results carry `link` when the variable is set and do not when it is unset.

### W3. People check right after `insert` — `eoffice-api-write.mjs`

- Today `create()` reads back with `readTask` (title search through `gets`). After `insert`,
  read the new task with `getItem(..., { raw: true })` by the ID found, **before** the status update.
- If `owner_ids` is empty while the payload had owners, or `assign_ids` is empty/null while the
  payload had assignees → result `{ created: true, submitted: false, externalId, link,
  error: "people not resolved: owner|assignees" }`, skip the status update, and stop the batch
  (no further tasks). The CLI exits 1.
- Partial resolution (fewer IDs stored than names sent) counts as not resolved.
- The final read-back after the status update also switches to `getItem`.
- Acceptance: CLI tests for: both resolved → normal flow; owner empty → stop, no `update` call
  recorded by `fakeFetch`, later tasks not inserted; partial assignees → stop.

### W4. `get` command — `eoffice-api-write.mjs`

```
node eoffice-api-write.mjs get --ids <id>[,<id>...] [--raw]
```

- Read-only; no host gate. One `getItem` per ID. Prints a JSON array of
  `{ id, found, title, status, percent, startPlan, endPlan, start, end, owner, assignees,
  creator, parentId, link }`; `found: false` for `Post not found`. `--raw` returns raw values.
- Exit 0 when every ID was found, 1 otherwise; usage errors exit 2.
- Acceptance: CLI tests for found / not found / mixed, `--raw`, bad `--ids` (empty, non-numeric) → 2.

### W5. `delete` command — `eoffice-api-write.mjs` (+ `deleteTask` in the lib)

```
node eoffice-api-write.mjs delete --dry-run --ids <id>[,<id>...]
node eoffice-api-write.mjs delete --apply --confirm-host <host> [--allow-production] [--allow-foreign] --ids <id>[,<id>...]
```

- Needs `EOFFICE_PROJECT_ID` or `--project-id <raw project id>` (the raw `project_id`, e.g. 3869,
  **not** `projectRef` 1456 — F6). The skill passes the target's `params.projectId`.
- Classification (dry-run and apply), from `getItem(..., { raw: true })`:
  - `absent` — `Post not found`; no call is made for it;
  - `refused` — `project_id` ≠ the given project ID, or `created_by_id` ≠ `1` (a task a person
    made by hand) unless `--allow-foreign`;
  - `deletable` — the rest.
- Apply: same host gate as `create`. Reclassify first; if any ID is `refused`, exit 2 before any
  `delete` call. Then for each `deletable` ID, in order: `POST /api/work/normal/delete` with
  `delIds=<that id>` (one ID per call, never a list — F5), wait `EOFFICE_SETTLE_MS`, `getItem`;
  `null` → `deleted`; still found → `still present`, stop.
- Output: JSON array of `{ id, title, link, result: "deleted" | "absent" | "refused" | "deletable" |
  "still present", reason?, error? }` (`deletable` only in dry-run). Exit 0 when nothing is
  `refused` or `still present`.
- Acceptance: CLI tests for each case in findings R1: recreate flow, out-of-scope delete, already
  absent, other project, hand-made task with and without `--allow-foreign`, `error:false` but still
  present, host gate (missing `--confirm-host`, production without `--allow-production`), and
  that `delIds` never contains a comma.

### W6. Error hints — `lib/eoffice-api.mjs`

- Append a hint to the thrown message, keeping `code`:
  - `not object` → "token unknown, truncated, or its API key has no object for work/normal;
    compare the token length with the admin page and check 'Last access time'";
  - `action not scopes` → "the API key can read but lacks this action; ask the eOffice admin to
    grant insert/update on work/normal";
  - `no_action` → "unknown eOffice action".
- Acceptance: unit tests per code; the token is still scrubbed.

### W7. `doctor` token check — `lib/doctor.mjs`

- Optional live check behind `doctor --online`: one `gets` with `limit=1`; reports `OK` or the W6
  hint. Without `--online`, doctor stays offline as today.
- Acceptance: unit test with an injected fetch for OK, `not object`, network error.

### W8. Docs and skill procedure

- `references/eoffice-api.md`:
  - people format per environment (production display names, UAT usernames) — F1;
  - F2 dates note; F3 creator note; F4 error table; `get`, `delete`, link variable;
  - fix the stale path `docs/eoffice-api-uat-checklist.md` → `docs/uat-checklist.md`;
  - Procedure step 7: ledger only results with `submitted: true`; a `people not resolved` result
    is deleted with `delete` (after the user approves) and recreated with corrected people.
- `SKILL.md` Step 7: the final report lists each task with its `link`; ledger entries keep
  `externalId` only (links are derived), and use `deletedAt`, `excluded`, `replaces` as in R1.
- `docs/uat-checklist.md`: split into UAT and production sections; record F1 for production;
  add unchecked items for O2–O5 and for the link template on UAT.
- `assets/projects.json.example`: show owner/assignees as display names, with a comment line in
  the reference explaining the per-environment format.

## Out of scope

- Changing how actual dates are written (needs O2 answered on UAT first).
- Fixing people through `update` (O3).
- Comma lists in `delIds` (O4).
- Any change to the progress-report flow or to `lark` / `manual`.

## Verification before merge

1. `npm test` green.
2. On UAT, with a UAT token: `create --apply` of one task with display-name people → people
   resolved check fails or passes as UAT dictates; `get` shows it with a working `link`;
   `delete --dry-run` then `--apply` removes it; `get` reports `found: false`. Tick the items in
   `docs/uat-checklist.md`.
3. Production only with the owner's explicit instruction: `get --ids 2133680` (read-only) shows
   owner Trần Nguyễn Đang Huy, Nguyễn Thụy Mai Khanh; assignees Hoàng Văn Châu, Trần Nguyễn Đang Huy;
   `link` = `https://eoffice.novagroup.vn/work-normal-normal/view?ID=2133680`.

## Suggested commits

1. `feat(eoffice): add item lookup and task link helpers` (W1, W2 lib)
2. `feat(eoffice): stop a batch when people do not resolve after insert` (W3)
3. `feat(eoffice): add get command` (W4)
4. `feat(eoffice): add delete command with per-id read-back` (W5)
5. `feat(eoffice): add links to create results and env example` (W2 CLI, assets, init)
6. `feat(eoffice): explain token and scope errors` (W6, W7)
7. `docs(eoffice): document production behaviour and new commands` (W8)

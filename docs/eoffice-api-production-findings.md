# eOffice API: production findings (2026-10-16)

Observed during the first supervised production run of `/log-task` on
`eoffice.novagroup.vn`, project 3869 (`params.projectId`; `params.projectRef` 1456),
parent 2089469. Each finding was read back after the call that caused it, through
`GET /api/work/normal/gets` (title search) or `GET /api/work/normal/item` (F7).
Several contradict `docs/uat-checklist.md`, which records UAT behaviour.

Sample sizes are small (one to three tasks per finding); "observed" means seen on
every attempt in this run, not proven server behaviour. Open points are listed at the end.

## Findings

### F1. Production resolves people by display name, not by username

| `owner_ids` / `assign_ids` sent | Stored (raw) | Task |
|---|---|---|
| `itc.cvcc.18` / `itc.cv.1,itc.cvcc.18` (usernames) | `""` / `null` | 2133602 (deleted) |
| `8990,7811` / `8990,112` (numeric user IDs) | `""` / `null` | 2133644, 2133668 (deleted) |
| `Trần Nguyễn Đang Huy,Nguyễn Thụy Mai Khanh` / `Trần Nguyễn Đang Huy,Hoàng Văn Châu` | `8990,7811` / `112,8990` | 2133680 |

- Unresolved people are dropped silently: `insert` returns `error: false`.
- `docs/uat-checklist.md` states the opposite for UAT ("usernames only, full names do
  not resolve"), so the accepted format differs per environment.
- The server reorders stored IDs; input order does not matter.
- Display names are not guaranteed unique. Two users with the same name would make the
  server pick one (or none); only a read-back of the numeric IDs detects that.

### F2. The REVIEW status update sets actual dates to the run date

- `insert` with `start=end=15/10/2026`, then the single `update status="Đang đánh giá"`
  → stored `start=end=2026-10-16` (the run date), on all four tasks created.
- `dates.actualFromPlan` therefore has no lasting effect on production.
- Whether `insert` alone keeps the sent actual dates was not tested (every task went
  through the status update).
- An `update` with `ID, owner_ids="7811", assign_ids="8990,7811", start, end` (no status)
  on 2133602 returned `error: false`, set `end` to 15/10, cleared `start` to `null`, and
  ignored the people. People in display-name form were not tried through `update`.

### F3. Tasks created by an API key belong to "Admin Hệ Thống"

- Every API-created task has `created_by_id: 1` (display "Admin Hệ Thống") and
  `department_created_id: null`. Hand-made tasks carry the user (8990) and a department (22147).
- Reports that filter by creator or creating department may not count these tasks for the
  user (not checked against any report).

### F4. Error responses

| Response | Meaning observed | When |
|---|---|---|
| `{"code":"not object","message":"accesstoken not of object"}` | Token unknown or truncated, or its API key has no object for `work/normal` | first call of the run (`gets`), or `insert` |
| `{"code":"action not scopes"}` | Token can read `work/normal` but its API key lacks the insert action | `insert`; `gets` succeeds with the same token |
| `"Không có bản ghi nào được chọn"` | `delete` received no IDs (wrong parameter name) | `delete` with `ID`, `ids`, `ids[]` |
| `"Post not found"` | No task with that ID (e.g. deleted) | `item` |
| `"action doesn't not exits"` (sic), `code: no_action` | Unknown action name | `/api/work/normal/<action>` |

- The first two reached the user as a bare message; a hint naming the probable cause would
  have saved several retries.
- While a token matched no key, the admin page showed "Last access time: --" (seen once).
- One token answered `not object` and, minutes later, worked: the API key was being edited.
  A permission error right after an admin change is worth one retry, not a token rotation.

### F5. Delete works with `delIds`

- `POST /api/work/normal/delete` with `delIds=<one id>` deletes; `item` then answers `Post not found`.
- Parameter name taken from the documented `POST /api/admin/user/delete`
  (`delIds`, comma-separated). A comma list was not tried on `work/normal`.
- Used to remove 2133602, 2133644, 2133668, one ID per call.

### F6. `gets` filters

- `{"ID": ...}`, `{"id": ...}` and `{"ids": ...}` are ignored: the call returns the
  unfiltered table (`total_item` ≈ 380 000, first row 55732). Code must never rely on
  `gets` to find a task by ID, and must never act on its first row.
- `{ s: <title>, parent_id }` works; `findDuplicate` / `readTask` already use it.
- With `field_raws=allfield` people are numeric IDs and `project_id` is the raw project ID
  (3869); without it people and project are display strings. Pairing both responses by `ID`
  yields an ID ↔ name map without access to a user object.

### F7. Task detail is `GET /api/work/normal/item?ID=<id>`

- Returns `{ error: false, data: { ... } }` with 78 fields for one task. `field_raws=allfield`
  switches people to numeric IDs and dates to `YYYY-MM-DD HH:mm:ss`, as in `gets`.
- A missing ID answers `Post not found` (F4): the read-back for `delete` and the existence
  check for a known `externalId`.
- `get`, `detail`, `view`, `info`, `show`, `getone`, `get-detail` do not exist (F4).
- The response carries no URL (`code: null`); a task link has to be built from a template.

## Requested features

### R1. `delete` command

```
node eoffice-api-write.mjs delete --dry-run --ids <id>[,<id>...]
node eoffice-api-write.mjs delete --apply --confirm-host <host> [--allow-production] --ids <id>[,<id>...]
```

- Dry-run (read-only): `item` with `field_raws=allfield` per ID. Print ID, title, status,
  owner, assignees, creator. Classify each ID:
  - `absent`: `item` answers `Post not found` → nothing to do;
  - `refused`: raw `project_id` differs from the target's `params.projectId` (3869, not
    `projectRef` 1456 — F6), or the creator is not the API account (`created_by_id` ≠ 1,
    i.e. a task a person made by hand) unless `--allow-foreign` is passed;
  - `deletable`: everything else.
- Apply: same host gate and `--allow-production` rule as `create` (production needs the
  user's explicit instruction in the run). Rerun the dry-run classification first and stop
  if any ID is `refused`. Then one `delete` call per `deletable` ID with `delIds=<that id>`
  (never a comma list, so a wrong ID cannot take others with it), read back with `item`,
  and stop at the first ID that is still present.
- Output per ID: `{ id, title, link, result: "deleted" | "absent" | "refused" | "still present", error? }`.
- Ledger (skill side, not the CLI): set `deletedAt`, plus `excluded: "<reason>"` when the work
  is out of scope, instead of removing the entry, so later runs do not propose it again.
  A recreated task gets the new `externalId` and `replaces: <old id>` on the same entry.
- Test cases:
  - trial record with wrong people or dates → delete, recreate, ledger `replaces`;
  - task created for out-of-scope work (cherry-pick / promotion) → delete, ledger `excluded`;
  - ID already deleted → `absent`, no `delete` call;
  - ID in another project → `refused` in dry-run, apply stops before any call;
  - hand-made task (`created_by_id` ≠ 1) → `refused` without `--allow-foreign`;
  - `delete` answers `error: false` but `item` still finds the task → `still present`, stop.

### R2. `get` command

```
node eoffice-api-write.mjs get --ids <id>[,<id>...] [--raw]
```

- Read-only, no host gate. `item` per ID; prints title, status, percent, plan and actual
  dates, owner, assignees, creator, parent, and `link` (R3). `--raw` adds `field_raws=allfield`.
- Used by the skill as the post-create read-back (replacing the `gets` title search,
  which is fragile per F6) and by the user to check a task without the UI.

### R3. Task link in every output

- Every result that carries an ID (create, get, delete, the skill's final report and its
  ledger summary) shows `link`.
- Built from a template because the API returns none (F7): `EOFFICE_TASK_URL_TEMPLATE` in the
  env file, placeholders `{origin}` (from `EOFFICE_BASE_URL`) and `{id}`. One source only, so
  UAT and production each get theirs from their own env file.
- No template → no `link` key and a one-line hint; never a guessed URL.
- The ledger stores `externalId` only; links are derived at display time, so a URL change
  does not leave stale links in the ledger.
- Production value, taken from the UI address bar for task 2133680 (O1):
  `EOFFICE_TASK_URL_TEMPLATE={origin}/work-normal-normal/view?ID={id}`
  → `https://eoffice.novagroup.vn/work-normal-normal/view?ID=2133680`.
  The path segment matches the `work-normal-normal` referer the progress-report call already
  sends, so the same template likely fits UAT; confirm once on UAT before relying on it.
- Reasonable default when the variable is unset: none (see above); the skill's `init` writes the
  production value into a new env file as a commented example.

## Proposed source changes

1. Docs: in `references/eoffice-api.md` and `docs/uat-checklist.md`, replace "people as
   usernames" with "people in the format the environment resolves (production: display
   names, UAT: usernames)"; add F2–F7; add a production section next to the UAT one. Fix the
   stale path in `references/eoffice-api.md` (`docs/eoffice-api-uat-checklist.md` → `docs/uat-checklist.md`).
2. `create --apply`: read back with `item` (`field_raws=allfield`) right after `insert`, before
   the status update. Empty or partial people → `created: true, submitted: false,
   error: "people not resolved"`, skip the status update, stop the batch. The task stays at its
   default status, easy to find and delete (R1), and is never ledgered as complete.
3. Add `delete` (R1) and `get` (R2) on top of `item`; add `link` (R3) to every result with an ID.
4. `lib/eoffice-api.mjs`: append the F4 hint to `not object` and `action not scopes`.
5. Dates: document F2. Only after O2 is answered, decide between dropping the
   `actualFromPlan` claim for production and adding a `--no-status` flag (insert only).
6. Optional `doctor` check: one read-only `gets` call with `limit=1`, so a bad token fails
   before a run.

## Open points

- ~~**O1** Task URL pattern~~ — answered: `{origin}/work-normal-normal/view?ID={id}` (R3). Still to
  confirm on UAT.
- **O2** Does `insert` without the status update keep the sent actual dates? One supervised
  task on UAT first, then production.
- **O3** Does `update` accept people as display names? Would allow fixing people without a delete.
- **O4** Does `delIds` with a comma list work on `work/normal`? Not needed by R1 (one ID per call).
- **O5** How the server resolves a display name shared by two users.

## Run record

| Task | People sent as | Result |
|---|---|---|
| 2133602 B5 | usernames | created without people; `update` cleared `start`; deleted |
| 2133644 B6 cherry-pick | numeric IDs | created without people; deleted (out of scope) |
| 2133668 B7 cherry-pick | numeric IDs | created without people; deleted (out of scope) |
| [2133680](https://eoffice.novagroup.vn/work-normal-normal/view?ID=2133680) B5 | display names | people correct; actual dates = run date; kept |

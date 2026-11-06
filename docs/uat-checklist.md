# eOffice API checklists

Record the date and result of each item. UAT items come first; production items record what was
observed on the first supervised run (2026-10-16, project 3869) and what is still open.
Details: [`eoffice-api-production-findings.md`](eoffice-api-production-findings.md).

## UAT

Use a UAT host and a UAT token with write permission on `work-normal-normal`.

- [ ] `search-parent` returns the expected parent for the project.
- [ ] `create --dry-run` shows the right title, host, and no duplicate.
- [ ] `create --apply` inserts one task; it appears in the UAT UI with the
      right title, parent, owner, assignees, and dates.
- [ ] Date format `dd/mm/YYYY` accepted by `insert`.
- [x] `project_id` = project code (verified on UAT); `params.projectRef` holds it.
- [x] On UAT, `owner_ids` / `assign_ids` take usernames only (full names do not resolve).
- [x] The four display-value flags at their defaults are accepted.
- [x] Status: one `update` with `ID` and `status="Đang đánh giá"` gives REVIEW/100%
      with actual dates; any further `update` wipes them.
- [x] `POST /work-task-task/progress` with session cookie + CSRF writes the report
      (task 14114, UAT); a REVIEW task refuses it.
- [x] Real CLI on UAT: flat task with `--session-from brave` creates the report record
      (task 14123); parent/child and cookie-less runs use one status update (14116/14117).
- [x] A report needs the task in DOING first: the CLI sends `update` DOING, waits, then reports.
- [x] Subtasks: one level under the new parent (14117 under 14116); the server hides the report
      button on subtasks and on tasks that have subtasks.
- [x] Host gate uses an exact allowlist (`EOFFICE_UAT_HOSTS`, default `eoffice-uat.novagroup.vn`).
- [ ] A second `create --apply` of the same batch skips the task as already existing.
- [ ] The `insert` response shape (record it; the CLI confirms by read-back).
- [ ] Task link template `{origin}/work-normal-normal/view?ID={id}` opens the task on UAT.
- [ ] `create --apply` with display-name people: resolved or stopped with `people not resolved`, as UAT dictates.
- [ ] `get --ids <id>` shows the task with a working `link`; `get --raw` shows numeric people IDs.
- [ ] `delete --dry-run` then `--apply` removes the task; `get` then reports `found: false`.
- [ ] `set-dates --apply --session-from brave --actual-from-plan` on a DOING task without an actual end changes the actual start and the read-back confirms it (a set actual end is refused: on production the route cleared it, 2026-10-26).

## Production (eoffice.novagroup.vn)

- [x] `POST /work-task-task/add?_json=1` with the session creates a task whose creator is the signed-in user (10100 probe, deleted).

- [x] People resolve by display name, not by username or numeric ID (F1; task 2133680).
- [x] `insert` answers `error: false` even when people are dropped (F1); the CLI checks by read-back.
- [x] `delete` with `delIds=<one id>` removes a task; `item` then answers `Post not found` (F5, F7).
- [x] The REVIEW status update sets the actual dates to the run date (F2).
- [x] API-created tasks have `created_by_id` 1 and no department (F3).
- [x] Token-less `create --via session` on production: duplicate guard from the `assign_all` list, people check from the edit form, status from the detail page (test task 2135885, deleted).
- [x] `report --dry-run` on the eight One Nova tasks (2135342, 2135345, 2135348, 2135351, 2135354, 2135357, 2135360, 2133680): all `done`, with the token and without it.
- [x] Session create + report by an assignee: actual start = plan start, end = report date (2135588 and 14 more).
- [x] A creator who is not an assignee cannot report; a user who is not an owner cannot edit dates (2135639).
- [x] O3: `update assign_ids` accepts a display name and changes the assignees, but clears actual start and end.
- [ ] O2: does `insert` without the status update keep the sent actual dates? One supervised task on UAT first.
- [ ] O3: does `update` accept people as display names?
- [ ] O4: does `delIds` accept a comma list on `work/normal`? (Not needed: the CLI deletes one ID per call.)
- [ ] O5: how the server resolves a display name shared by two users.
- [ ] Read-only check: `get --ids 2133680` shows the expected people and `link`.

Production writes: only with the owner's explicit instruction in that run.

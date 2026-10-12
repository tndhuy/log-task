# eOffice API UAT checklist

Record the date and result of each item before any production write. Use a UAT
host and a UAT token with write permission on `work-normal-normal`.

- [ ] `search-parent` returns the expected parent for the project.
- [ ] `create --dry-run` shows the right title, host, and no duplicate.
- [ ] `create --apply` inserts one task; it appears in the UAT UI with the
      right title, parent, owner, assignees, and dates.
- [ ] Date format `dd/mm/YYYY` accepted by `insert`.
- [x] `project_id` = project code (verified on UAT); `params.projectRef` holds it.
- [x] `owner_ids` / `assign_ids` take usernames only (full names do not resolve).
- [x] The four display-value flags at their defaults are accepted.
- [x] Status: one `update` with `ID` and `status="Đang đánh giá"` gives REVIEW/100%
      with actual dates; any further `update` wipes them.
- [x] `POST /work-task-task/progress` with session cookie + CSRF writes the report
      (task 14114, UAT); a REVIEW task refuses it.
- [x] Real CLI on UAT: flat task with `--session-from brave` creates the report record
      (task 14123); cha/con and cookie-less runs use one status update (14116/14117).
- [x] A report needs the task in DOING first: the CLI sends `update` DOING, waits, then reports.
- [x] Subtasks: one level under the new parent (14117 under 14116); the server hides the report
      button on subtasks and on tasks that have subtasks.
- [x] Host gate uses an exact allowlist (`EOFFICE_UAT_HOSTS`, default `eoffice-uat.novagroup.vn`).
- [ ] Confirm the owner/assignee usernames on production before the supervised task.
- [ ] A second `create --apply` of the same batch skips the task as already existing.
- [ ] The `insert` response shape (record it; the CLI confirms by read-back).

Production: one supervised task, only after every item above is checked.

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
- [ ] Run the real CLI on UAT with and without `EOFFICE_SESSION_COOKIE` and compare in the UI.
- [ ] Confirm the owner/assignee usernames on production before the supervised task.
- [ ] A second `create --apply` of the same batch skips the task as already existing.
- [ ] The `insert` response shape (record it; the CLI confirms by read-back).

Production: one supervised task, only after every item above is checked.

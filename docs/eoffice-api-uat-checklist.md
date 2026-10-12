# eOffice API UAT checklist

Record the date and result of each item before any production write. Use a UAT
host and a UAT token with write permission on `work-normal-normal`.

- [ ] `search-parent` returns the expected parent for the project.
- [ ] `create --dry-run` shows the right title, host, and no duplicate.
- [ ] `create --apply` inserts one task; it appears in the UAT UI with the
      right title, parent, owner, assignees, and dates.
- [ ] Date format `dd/mm/YYYY` accepted by `insert`.
- [ ] `project_id` accepts the project code or the raw ID (record which; set
      `params.projectRef` accordingly).
- [ ] Full names in `owner_ids` and `assign_ids` resolve to the right people.
- [ ] The seven required flags at their defaults are accepted.
- [ ] Status route: with `status=REVIEW`, does the task reach `percent=100`?
      If not, try `status=COMPLETED`, then `progress_type=TIMEFINISH`. If none
      works, use the Playwright `report-progress` step.
- [ ] `update` takes `id` (the docs table lists no `id` row).
- [ ] A second `create --apply` of the same batch skips the task as already existing.
- [ ] The `insert` response shape (record it; the CLI confirms by read-back).

Production: one supervised task, only after every item above is checked.

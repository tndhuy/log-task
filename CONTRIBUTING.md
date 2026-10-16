# Contributing

## Layout

```
skills/log-task/        the installable skill (what `npx skills add` copies)
  SKILL.md              the agent procedure
  scripts/              CLIs and libraries the procedure calls
  references/           one file per platform
assets/                 example config files copied by users
tests/                  mirrors scripts/ (node --test)
docs/uat-checklist.md   manual checks to run against UAT before production
```

Only `skills/log-task/` reaches users. Keep tests, design notes and anything
personal out of it.

## Rules

- No npm dependencies. Use the Node standard library.
- Per-user data (`projects.json`, ledgers, state) lives in the data directory
  from `scripts/lib/data-dir.mjs`, never inside the skill directory.
- Anything that writes to an external system needs a dry-run mode and an
  explicit confirmation flag. Tokens and cookies are never printed or stored.
- Run `npm test` before every commit. Use concise conventional commits.
- Verify eOffice behaviour on UAT first and tick the matching item in
  `docs/uat-checklist.md`.

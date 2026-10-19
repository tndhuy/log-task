# log-task

An agent skill that turns your finished work (git commits, Claude Code history,
checkpoints) into task records on the platform each project declares:
**eOffice** (API), **Lark Base**, or a **manual** markdown file. Invoke it with
`/log-task`. Nothing is written until you approve the draft.

## Requirements

- Node.js 22.13 or newer and `git`. No `npm install` is needed.
- An agent that supports skills (Claude Code, Codex, Cursor, ...).
- `eoffice-api`: be signed in to eOffice in Brave or Chrome (the session cookie is read from the macOS Keychain);
  that is enough to create tasks and report progress. An admin-issued `access_token` for `work-normal-normal` is
  optional and only needed for delete, get and tasks with subtasks.
- `lark`: a Lark Base `baseToken` and `tableId`. `manual`: nothing extra.

## Install

```bash
npx skills add tndhuy/log-task                        # interactive: pick your agents
npx skills add tndhuy/log-task -a claude-code -g -y   # Claude Code, all projects, no prompts
```

Update later with `npx skills update log-task`. Your configuration lives outside
the skill directory, so updates never overwrite it.

## Configure (once, about 3 minutes)

1. Create your data directory with starter files. It never overwrites existing files:

   ```bash
   node ~/.claude/skills/log-task/scripts/init.mjs
   ```

   This creates `~/.config/log-task/projects.json` (your git email filled in) and a
   private `eoffice.env` (mode 600). The commands work from any directory, because the
   shell expands `~` to your home. Set `LOG_TASK_HOME` to an absolute path to use another
   directory. If you installed per project (no `-g`) or for another agent, replace
   `~/.claude/skills/log-task` with the path `npx skills` printed.

2. Edit `~/.config/log-task/projects.json`: one entry per project, or one
   `"type": "group"` entry for a workspace folder that holds several repos.
   - `platform`: `eoffice-api`, `lark` or `manual`.
   - `gitEmails`: the emails on your commits. A wrong email finds no work.
   - `eoffice-api` repos also need `rules` (task name template, project
     `projectRef`/`projectId`, parent candidates, assignee usernames).

3. `eoffice-api` only: put your values in `~/.config/log-task/eoffice.env`.
   The scripts load this file automatically; no `--env-file` flag is needed.

   | Variable | Required | Meaning |
   |---|---|---|
   | `EOFFICE_BASE_URL` | yes | Origin only, for example `https://host.example.vn` (no path) |
   | `EOFFICE_ACCESS_TOKEN` | no | Integration token issued by an admin. Used first whenever it is set (faster, more complete). Without it, `create --via session`, `get`, `set-dates` and `search-parent` read through your browser session. Only `delete`, parent/child tasks, `--no-report` and `--via api` still need it |
   | `EOFFICE_UAT_HOSTS` | no | Comma-separated hosts treated as UAT. Any other host needs an explicit "write to production" instruction |
   | `EOFFICE_SESSION_COOKIE` | no | Session cookie for the progress-report record. Prefer `--session-from brave\|chrome` |
   | `EOFFICE_SETTLE_MS` | no | Pause between API steps, default 3000 |

   Variables already exported in your shell win over the file. To target another
   environment, pass that file as two words; it then replaces the default file entirely: `node --env-file "$HOME/prod.env" ...`
   (`--env-file=~/prod.env` is not expanded by the shell). Values in env files must be
   absolute paths or plain text, never `~`.
   The agent never reads these files, and tokens and cookies are never printed or stored.

4. Check the setup from your project folder:

   ```bash
   node ~/.claude/skills/log-task/scripts/doctor.mjs
   ```

   It checks Node, git, the config, which project the current folder maps to, and
   whether the required variables are set (names only, never values).

## Use

1. Open your agent in a project (or in the group folder) and run `/log-task`.
2. Give the date window. The skill gathers commits, Claude history and
   checkpoints, and drops work that is already in the ledger.
3. Review the draft. Approve it or ask for edits.
4. For `eoffice-api`, run the proposed `--dry-run` first, then `--apply`.
   Writing to a host outside the UAT list requires you to say so in that run.

Useful checks for `eoffice-api` (details in `skills/log-task/references/eoffice-api.md`):

- `eoffice-api-write.mjs get --ids <id>[,<id>...]` shows a task and its link, read-only.
- `eoffice-api-write.mjs delete --dry-run --project-id <rawId> --ids <id>` then `--apply`
  removes tasks the skill created by mistake.
- People in `rules` use the format of the environment: display names on production,
  usernames on UAT. A batch stops when the server drops them.
- `doctor.mjs --online` makes one read call to confirm the token works.
- `eoffice-api-write.mjs report --dry-run --project-id <rawId> --items items.json` confirms tasks already carry their
  evidence dates and report; `--apply` sends the missing reports.

## Platforms

| Platform | Writes to | Reference |
|---|---|---|
| `eoffice-api` | eOffice tasks via the integration API, with per-project naming rules | `skills/log-task/references/eoffice-api.md` |
| `lark` | a Lark Base table | `skills/log-task/references/lark.md` |
| `manual` | a markdown file you copy from | `skills/log-task/references/manual.md` |

## Development

```bash
npm test      # Node's built-in test runner, no dependencies
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the layout and conventions.

## License

[MIT](LICENSE)

# log-task

An agent skill that turns your finished work (git commits, Claude Code history,
checkpoints) into task records on the platform each project declares:
**eOffice** (API), **Lark Base**, or a **manual** markdown file. Invoke it with
`/log-task`. Nothing is written until you approve the draft.

## Requirements

- Node.js 22.13 or newer and `git`. No `npm install` is needed.
- An agent that supports skills (Claude Code, Codex, Cursor, ...).
- `eoffice-api`: an eOffice `access_token` with rights on the `work-normal-normal`
  object, issued by your eOffice admin. For the progress-report record, also be
  signed in to eOffice in Brave or Chrome (cookies are read from the macOS Keychain).
- `lark`: a Lark Base `baseToken` and `tableId`. `manual`: nothing extra.

## Install

```bash
npx skills add tndhuy/log-task                        # interactive: pick your agents
npx skills add tndhuy/log-task -a claude-code -g -y   # Claude Code, all projects, no prompts
```

Update later with `npx skills update log-task`. Your configuration lives outside
the skill directory, so updates never overwrite it.

## Configure (once, about 5 minutes)

1. Create the data directory and copy the example config:

   ```bash
   mkdir -p ~/.config/log-task
   cp ~/.claude/skills/log-task/assets/projects.json.example ~/.config/log-task/projects.json
   ```

   Set `LOG_TASK_HOME` to use a different directory.

2. Edit `projects.json`: one entry per project, or one `"type": "group"` entry
   for a workspace folder that holds several repos.
   - `platform`: `eoffice-api`, `lark` or `manual`.
   - `gitEmails`: the emails on your commits. A wrong email finds no work.
   - `eoffice-api` repos also need `rules` (task name template, project
     `projectRef`/`projectId`, parent candidates, assignee usernames).

3. `eoffice-api` only: create a private env file outside any repo and restrict it.

   ```bash
   cp ~/.claude/skills/log-task/assets/env.example ~/.config/log-task/eoffice.env
   chmod 600 ~/.config/log-task/eoffice.env
   ```

   | Variable | Required | Meaning |
   |---|---|---|
   | `EOFFICE_BASE_URL` | yes | Origin only, for example `https://host.example.vn` (no path) |
   | `EOFFICE_ACCESS_TOKEN` | yes | Integration token |
   | `EOFFICE_UAT_HOSTS` | no | Comma-separated hosts treated as UAT. Any other host needs an explicit "write to production" instruction |
   | `EOFFICE_SESSION_COOKIE` | no | Session cookie for the progress-report record. Prefer `--session-from brave\|chrome` |
   | `EOFFICE_SETTLE_MS` | no | Pause between API steps, default 3000 |

   The agent never reads this file. It gives you commands of the form
   `node --env-file=~/.config/log-task/eoffice.env ... create --dry-run ...` to run yourself.
   Tokens and cookies are never printed or stored.

## Use

1. Open your agent in a project (or in the group folder) and run `/log-task`.
2. Give the date window. The skill gathers commits, Claude history and
   checkpoints, and drops work that is already in the ledger.
3. Review the draft. Approve it or ask for edits.
4. For `eoffice-api`, run the proposed `--dry-run` first, then `--apply`.
   Writing to a host outside the UAT list requires you to say so in that run.

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

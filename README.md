# Repomate

Inject AI agents into any repository. GitHub Issue → Agent → PR automation.

## Overview

4-phase automation loop:

1. **Analyze**: Detect labeled Issues → Agent analyzes → posts plan as comment
2. **Implement**: 👍 approval → isolated worktree → PR creation
3. **Review**: Detect PR review comments → auto-fix → push
4. **Conflict**: Detect main conflicts → auto rebase/resolve

## Quick Start

```bash
# 1. Install
npm install github:uyah/repomate

# 2. Create config
cp node_modules/repomate/config.example.json repomate.config.json
# Edit repomate.config.json

# 3. Start task runner
npx repomate-runner --config repomate.config.json
```

## Components

### bin/task-runner.sh

Main automation loop. Specify JSON config with `--config`.

```bash
npx repomate-runner --config repomate.config.json           # continuous polling
npx repomate-runner --config repomate.config.json --once    # run once
npx repomate-runner --config repomate.config.json --dry-run # dry run
```

### bin/worktree.sh

Git worktree management helper.

```bash
npx repomate-worktree --config repomate.config.json create fix/42
npx repomate-worktree --config repomate.config.json list
npx repomate-worktree --config repomate.config.json remove fix/42
```

### bin/deploy.sh

Git pull + tmux session restart.

```bash
npx repomate-deploy --config repomate.config.json
```

### server/ (webhook server)

REST API + SQLite task queue + optional Slack Bot.

```javascript
import { createApp } from 'repomate/server';

const { app, cleanup } = await createApp(config);
```

#### Routes

| Method | Path | Description |
|--------|------|-------------|
| GET | /health | Health check |
| POST | /task | Create task (async) |
| POST | /task/sync | Create task (sync) |
| GET | /task/:id | Get task |
| GET | /tasks | List tasks |
| POST | /task/:id/reply | Continue conversation |
| GET | /task/:id/stream | SSE stream |
| DELETE | /task/:id | Cancel task |
| POST | /task/:id/retry | Retry |
| POST | /task/:id/merge | Merge worktree → main |
| POST | /task/:id/pr | Create PR |
| POST | /task/:id/discard | Discard changes |
| GET | /status | System status |
| POST | /deploy | Trigger deploy |

#### Adapters

- **slack**: Slack Socket Mode Bot (`SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` required)
- **cloudflare-auth**: User identification from CF Access headers

## Configuration

`repomate.config.json`:

```jsonc
{
  "repo": "owner/repo-name",
  "label": "repomate",
  "repoDir": "$HOME/Workspace/project",
  "worktreeBase": "$HOME/Workspace/project-worktrees",

  "auth": {
    "type": "gh-cli"                    // or "github-app"
  },

  "pollInterval": 180,

  "phases": {
    "analyze":   { "maxTurns": 10, "useWorktree": true },
    "implement": {
      "maxTurns": 30,
      "preCommands": ["npm ci --silent"],
      "postValidation": ["npm run test:run", "npm run lint"],
      "promptSuffix": ""
    },
    "review":    { "maxTurns": 15 },
    "conflict":  { "maxTurns": 15 }
  },

  "webhookServer": {
    "port": 8080,
    "adapters": ["slack"],
    "deployScript": "./scripts/deploy.sh"
  },

  "deploy": {
    "tmuxSessions": {
      "task-runner": "cd $REPO_DIR && exec ./scripts/task-runner.sh"
    }
  }
}
```

### GitHub App Auth

When `auth.type: "github-app"`, set these environment variables:

```bash
export REPOMATE_APP_ID="..."
export REPOMATE_INSTALLATION_ID="..."
export REPOMATE_PEM_FILE="$HOME/.config/bot/private-key.pem"
```

## GitHub Actions Templates

Templates in `templates/workflows/`:

- `claude.yml.template` — @claude PR review
- `deploy.yml.template` — push → deploy

## Setup

Set up a new machine from scratch:

```bash
npx repomate-setup --repo owner/repo --dir ~/Workspace/project --user bot-name --email bot@example.com
```

## Dependencies

- `jq` (required for task-runner.sh JSON parsing)
- `gh` (GitHub CLI)
- `claude` (Claude Code CLI)
- `git`, `tmux`

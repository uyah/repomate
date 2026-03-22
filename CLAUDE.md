# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**Repomate** — AI agent automation framework that drives GitHub Issue → Agent → PR workflows. It runs a 4-phase loop (Analyze → Implement → Review → Conflict Resolution) using Claude Code CLI or Codex as the AI runner, with isolated git worktrees per task.

## Commands

```bash
# Install dependencies
npm install

# Start the webhook server (requires --config or REPOMATE_CONFIG env)
npm start -- --config repomate.config.json
# or
node server/index.js --config repomate.config.json

# Start the 4-phase automation loop
npx repomate-runner --config repomate.config.json          # continuous polling
npx repomate-runner --config repomate.config.json --once   # single pass
npx repomate-runner --config repomate.config.json --dry-run

# Worktree management
npx repomate-worktree --config repomate.config.json create|list|remove <branch>

# Deploy (git pull + tmux session restart)
npx repomate-deploy --config repomate.config.json
```

There is no test suite or linter for this project itself. Post-validation commands (test/lint) are configured per-target-repo in `repomate.config.json` phases.

## Architecture

ES modules (`"type": "module"`), Node.js backend with Hono framework, SQLite (better-sqlite3, WAL mode), vanilla JS frontend (PWA).

### Server (`server/`)

- **`index.js`** — Entry point. Loads `.env`, parses `--config`, resolves `$HOME` in config values, manages PID file for process replacement, starts HTTP server.
- **`core/app.js`** — Hono app factory. Wires all modules, sets up reverse proxy for dev server subdomains, serves dashboard/logs HTML. Returns `{ app, runner, worktrees, baseDomain, cleanup }`.
- **`core/routes.js`** — REST API routes. Task CRUD, SSE streaming (`/task/:id/stream`), worktree operations (merge/PR/discard), push notifications, deploy trigger.
- **`core/claude-runner.js`** — Task execution engine. Spawns `claude` CLI or Codex processes, manages AbortControllers, tracks live output streams and API costs. Codex supports "loop-until-done" mode via `[[TASK_DONE]]` marker.
- **`core/worktree.js`** — Git worktree lifecycle. Creates isolated worktrees, copies `.env`, generates agent instruction files (`.claude/CLAUDE.local.md` for Claude, `AGENTS.md` for Codex), manages dev server processes with WebSocket upgrade handling.
- **`core/db.js`** — SQLite schema with auto-migrations. Tables: `tasks`, `push_subscriptions`, `users`, `comments`.
- **`core/push.js`** — Web Push (VAPID) notification management.
- **`adapters/slack.js`** — Slack Socket Mode bot. Maps Slack threads to tasks, handles file attachments.
- **`adapters/cloudflare-auth.js`** — User identification from CF Access headers.
- **`dashboard.html`** — SPA frontend (~2100 lines). Real-time SSE streaming, model/runner selection, plan mode approval, worktree status, push notification subscriptions, dark theme.

### Shell Scripts (`bin/`)

- **`task-runner.sh`** — Main 4-phase orchestrator (~760 lines). Uses `jq` for JSON config parsing and `gh` CLI for GitHub operations. Logs to `~/logs/task-runner/{repo}/`.
- **`worktree.sh`** — Git worktree helper commands.
- **`deploy.sh`** — Git pull + tmux session restart.
- **`setup.sh`** — Initial machine setup (git config, SSH keys, tool installation).
- **`gh-app-token.sh`** — GitHub App JWT → installation token refresh.

### Configuration

`repomate.config.json` (schema: `config.schema.json`, example: `config.example.json`). Supports `$HOME` variable expansion. Key fields: `repo`, `label`, `repoDir`, `worktreeBase`, `auth`, `phases` (per-phase: `maxTurns`, `useWorktree`, `preCommands`, `postValidation`, `promptSuffix`), `webhookServer`, `deploy`.

### Data Storage

SQLite database at `.automation/tasks.db`. Uploads at `.automation/uploads/`. PID file for server process management.

### External Tool Dependencies

`jq`, `gh` (GitHub CLI), `claude` (Claude Code CLI), `git`, `tmux`.

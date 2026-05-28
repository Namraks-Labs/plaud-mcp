# plaud-mcp

A local [Model Context Protocol](https://modelcontextprotocol.io) server that syncs your [Plaud](https://www.plaud.ai) Note Pro / NotePin recordings — AI summaries, highlights, and diarized transcripts — into plain markdown files on your machine, and exposes them to MCP clients like Claude.

Each recording becomes one markdown file with YAML frontmatter, so it drops straight into Obsidian, a notes folder, or any tool that reads markdown. Sync is incremental and idempotent.

> **Note:** Plaud has no official public API. This talks to the same backend the web app at [web.plaud.ai](https://web.plaud.ai) uses, reverse-engineered from observed traffic (the same approach as the [plaud-sync-for-obsidian](https://github.com/leonardsellem/plaud-sync-for-obsidian) plugin). It may break without notice if Plaud changes their backend. Use at your own risk; this project is not affiliated with Plaud.

## Contents

- [Features](#features)
- [Install](#install)
- [The sync token](#the-sync-token) — read this first; it's the only fiddly part
- [Use as a CLI](#use-as-a-cli)
- [Use with Claude](#use-with-claude) — Claude Code and Claude Desktop
- [Use with an agent / automation](#use-with-an-agent--automation) — headless, scheduled
- [Managing it](#managing-it)
- [Configuration](#configuration)
- [Output format](#output-format)

## Features

- **MCP server** — `plaud_sync`, `plaud_list`, `plaud_get_recording`, `plaud_transcribe`, `plaud_status` tools over stdio.
- **CLI** — the same operations from the terminal, for first-time auth and scheduled syncs.
- **Transcribe on demand** — trigger Plaud's cloud transcription + AI summary generation for recordings that haven't been processed yet (not just pull already-processed ones).
- **Markdown output** — one file per recording: `summary`, `highlights`, and a speaker-diarized `transcript`, with frontmatter (`plaud_file_id`, `title`, `date`, `duration_sec`, `language`).
- **Idempotent** — matching is by `plaud_file_id` in frontmatter, so re-syncing is safe and renaming files by hand won't create duplicates.

## Install

```sh
# one-off, no install
npx -y @namraks-labs/plaud-mcp --help

# or clone (npm install runs the build automatically)
git clone https://github.com/Namraks-Labs/plaud-mcp.git
cd plaud-mcp && npm install
```

## The sync token

Plaud has no API keys. Authentication is a **JWT from your logged-in web session** — this is the only fiddly part of setup, so it's worth doing once, carefully.

**Get the token:**

1. Log in at [web.plaud.ai](https://web.plaud.ai).
2. Open DevTools → **Network** tab. Filter by your api host (e.g. `api-euc1`). Reload the page.
3. Click any request → **Headers** → **Request Headers** → copy the value after `authorization: bearer ` (the long `eyJ…` string).

**Set the token** — three ways, pick one:

```sh
# 1. Save to a file (chmod 600). Omit the arg to read from stdin and keep it
#    out of your shell history — recommended:
pbpaste | plaud-mcp auth            # macOS; or: plaud-mcp auth  (then paste at the prompt)
plaud-mcp auth eyJ…                 # or pass it directly

# 2. Environment variable (good for MCP client config and CI):
export PLAUD_TOKEN=eyJ…
```

The env var wins over the saved file when both are present.

**Region:** if your account is not on the default `https://api.plaud.ai`, set your host once (EU accounts use `api-euc1`):

```sh
plaud-mcp api https://api-euc1.plaud.ai
```

Find your host in DevTools → Console: `localStorage.getItem("pld_plaud_user_api_domain")`.

**Expiry:** the token is a real JWT with an `exp` claim — observed lifetime is ~1 year. `plaud-mcp status` decodes it and tells you how many days are left. When it expires, sync fails with a clear `HTTP 401`; repeat the steps above to refresh it.

## Use as a CLI

```sh
plaud-mcp sync                  # sync new recordings (incremental)
plaud-mcp sync --dry-run        # show what would sync, write nothing
plaud-mcp sync --force          # re-sync everything (overwrites by file id)
plaud-mcp list --limit 20       # list recordings on the cloud
plaud-mcp list --on 2026-05-26  # filter by local date (or --since/--until a range)
plaud-mcp list --title "standup" # filter by recording name (substring, case-insensitive)
plaud-mcp transcribe <id>       # trigger cloud transcription + AI summary, wait, write markdown
plaud-mcp transcribe-all        # transcribe every recording missing a transcript/summary
plaud-mcp get <file-id>         # print one recording's markdown to stdout
plaud-mcp status                # show config, token expiry, last-sync timestamp
```

### Generating transcriptions

`sync` only pulls recordings Plaud has **already** transcribed. To kick off transcription + AI summary generation for a recording that hasn't been processed yet (or to re-run it), use `transcribe`:

```sh
plaud-mcp transcribe <file-id> --language sv      # Swedish; use "auto" to let Plaud detect
plaud-mcp transcribe <file-id> --save             # also persist the result back to the Plaud cloud
plaud-mcp transcribe <file-id> --no-start         # don't trigger a new job, just fetch/render the current result
plaud-mcp transcribe <file-id> --no-summary-wait  # return as soon as the transcript is ready
```

This **consumes your Plaud transcription quota** (same as pressing "Transcribe" in the app). It triggers the job, polls until it finishes, then writes the markdown like `sync` does. Under the hood: `PATCH /file/{id}` sets the transcription config, `POST /ai/transsumm/{id}` is polled for the result, and `--save` writes it back via `PATCH /file/{id}`. The summary template defaults to `REASONING-NOTE` (the web app's default).

The **transcript task finishes before the AI summary task**, so by default `transcribe` keeps polling until the summary lands too. Pass `--no-summary-wait` to return as soon as the transcript is ready. By default the result is also **saved back to the Plaud cloud** (so the web app and `sync` see it); pass `--no-save` to keep it local-only.

To process everything that hasn't been transcribed yet in one go:

```sh
plaud-mcp transcribe-all --dry-run    # preview which recordings would be processed
plaud-mcp transcribe-all              # transcribe all of them (consumes quota per recording)
plaud-mcp transcribe-all --limit 5    # cap how many run
```

`transcribe-all` targets every recording missing a transcript **or** a summary (detected via the `is_trans` / `is_summary` flags on the file list).

### Filtering (list & transcribe-all)

Both `list` and `transcribe-all` accept the same filters, so you can scope to a time window and/or a recording name:

```sh
plaud-mcp list --since 2026-05-26 --until 2026-05-27   # local date range (inclusive)
plaud-mcp list --on 2026-05-26                         # shorthand for a single day
plaud-mcp list --title "weekly sync"                   # name substring, case-insensitive
plaud-mcp transcribe-all --on 2026-05-26 --trigger-only   # transcribe only that day's recordings
```

- **Dates are local** (the recording's own timezone) and accept `YYYY-MM-DD` or `YYYY-MM-DD HH:MM`. `--since`/`--until` are inclusive; `--on` is a shorthand for both.
- **`--title`** matches the recording's name as stored by Plaud (the in-app name, or the auto-assigned timestamp for un-named recordings). Note the list does not carry the AI-generated title — that lives in each recording's markdown, so grep the vault to search by generated title.

## Use with Claude

The server runs over stdio. With no arguments, `plaud-mcp` starts the MCP server.

### Claude Code

```sh
claude mcp add plaud \
  -e PLAUD_API_DOMAIN=https://api-euc1.plaud.ai \
  -e PLAUD_NOTES_DIR=$HOME/plaud-notes \
  -- npx -y @namraks-labs/plaud-mcp
```

If you've already run `plaud-mcp auth`, the saved token file is used and you can drop `PLAUD_TOKEN`. Otherwise add `-e PLAUD_TOKEN=eyJ…`.

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "plaud": {
      "command": "npx",
      "args": ["-y", "@namraks-labs/plaud-mcp"],
      "env": {
        "PLAUD_TOKEN": "eyJ…",
        "PLAUD_API_DOMAIN": "https://api-euc1.plaud.ai",
        "PLAUD_NOTES_DIR": "/Users/you/plaud-notes"
      }
    }
  }
}
```

Tools exposed:

| Tool | Description |
| --- | --- |
| `plaud_sync` | Pull new recordings into markdown files. Args: `force`, `limit`, `dryRun`. |
| `plaud_list` | List recordings on the cloud without syncing. Args: `limit`, `since`, `until`, `titleContains`. |
| `plaud_get_recording` | Fetch one recording's rendered markdown by `fileId`, without writing it. |
| `plaud_transcribe` | Trigger cloud transcription + AI summary for a recording, wait, write the markdown, and save back to the cloud. Args: `fileId`, `language`, `summType`, `save`, `waitForSummary`, `timeoutSec`. Consumes quota. |
| `plaud_transcribe_all` | Transcribe every recording missing a transcript/summary. Args: `language`, `summType`, `limit`, `dryRun`, `save`, `triggerOnly`, `since`, `until`, `titleContains`. Consumes quota per recording — use `dryRun` first. |
| `plaud_status` | Show token source/expiry, API domain, notes/state dirs, last sync. |

## Use with an agent / automation

The CLI subcommands are designed to be driven headlessly — by a cron job, a launchd agent, a systemd timer, or an autonomous coding agent. The pattern is always: set the `PLAUD_*` env vars, then call `plaud-mcp sync`.

**Generic headless sync:**

```sh
PLAUD_TOKEN=eyJ… \
PLAUD_API_DOMAIN=https://api-euc1.plaud.ai \
PLAUD_NOTES_DIR=$HOME/plaud-notes \
  npx -y @namraks-labs/plaud-mcp sync
```

**cron (every hour):**

```cron
0 * * * * PLAUD_NOTES_DIR=$HOME/plaud-notes /usr/local/bin/plaud-mcp sync >> $HOME/.plaud-mcp/logs/sync.log 2>&1
```

**macOS launchd** — a ready-to-edit agent is in [`examples/launchd.plist`](examples/launchd.plist). Copy it to `~/Library/LaunchAgents/`, edit the paths/env, then:

```sh
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.example.plaud-mcp.plist
launchctl kickstart -p "gui/$(id -u)/com.example.plaud-mcp"   # run once now
```

**systemd (Linux)** — a `.service` + `.timer` pair is in [`examples/systemd/`](examples/systemd/).

For an autonomous agent, the contract it needs is in [`AGENTS.md`](AGENTS.md): how to authenticate, sync, and diagnose failures without a human in the loop.

## Managing it

```sh
plaud-mcp status        # token source + days-until-expiry, api domain, last sync, seen count
```

- **Token expired?** `status` shows `EXPIRED`, and `sync` exits non-zero with an `HTTP 401`. Re-extract the JWT (see [The sync token](#the-sync-token)) and re-run `plaud-mcp auth`.
- **Rate limited?** `sync` exits with `HTTP 429`. Wait a few minutes and retry.
- **Re-sync from scratch?** Delete `~/.plaud-mcp/state.json` and run `plaud-mcp sync --force`. Idempotent — existing files are overwritten in place, not duplicated.
- **Scheduled job went quiet?** Check the job's log. A healthy idle run prints `N total, 0 candidate(s)`. Auth/network failures print a `plaud-mcp: …` line to stderr.

## Configuration

Environment variables override the saved config files.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PLAUD_TOKEN` | — | JWT (alternative to `plaud-mcp auth`). |
| `PLAUD_API_DOMAIN` | `https://api.plaud.ai` | API host for your region. |
| `PLAUD_NOTES_DIR` | `~/plaud-notes` | Output directory for markdown files. |
| `PLAUD_STATE_DIR` | `~/.plaud-mcp` | Where the token, sync state, and config live. |

State files under `PLAUD_STATE_DIR`:

- `token` — JWT, `chmod 600`.
- `state.json` — `{ lastSyncMs, seenIds[] }` for incremental sync.
- `config.json` — saved API domain.

## Output format

```markdown
---
plaud_file_id: 286eea0e49fd44dfd7f704f52d9ee3d8
title: "Strategy meeting"
date: 2026-05-11T08:30:00.000Z
duration_sec: 2734
language: sv
source: plaud
---

# Strategy meeting

## Summary
…Plaud's AI summary…

## Highlights
- key point 1
- key point 2

## Transcript
**Speaker 1:** …
**Speaker 2:** …
```

Files are written to `PLAUD_NOTES_DIR/YYYY-MM-DD/<slug>-<id6>.md`, grouped by the recording's start date.

## License

MIT © Namraks Labs

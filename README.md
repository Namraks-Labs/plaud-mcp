# plaud-mcp

A local [Model Context Protocol](https://modelcontextprotocol.io) server that syncs your [Plaud](https://www.plaud.ai) Note Pro / NotePin recordings — AI summaries, highlights, and diarized transcripts — into plain markdown files on your machine, and exposes them to MCP clients like Claude.

Each recording becomes one markdown file with YAML frontmatter, so it drops straight into Obsidian, a notes folder, or any tool that reads markdown. Sync is incremental and idempotent.

> **Note:** Plaud has no official public API. This talks to the same backend the web app at [web.plaud.ai](https://web.plaud.ai) uses, reverse-engineered from observed traffic (the same approach as the [plaud-sync-for-obsidian](https://github.com/leonardsellem/plaud-sync-for-obsidian) plugin). It may break without notice if Plaud changes their backend. Use at your own risk; this project is not affiliated with Plaud.

## Features

- **MCP server** — `plaud_sync`, `plaud_list`, `plaud_get_recording`, `plaud_status` tools over stdio.
- **CLI** — the same operations from the terminal, for first-time auth and scheduled syncs.
- **Markdown output** — one file per recording: `summary`, `highlights`, and a speaker-diarized `transcript`, with frontmatter (`plaud_file_id`, `title`, `date`, `duration_sec`, `language`).
- **Idempotent** — matching is by `plaud_file_id` in frontmatter, so re-syncing is safe and renaming files by hand won't create duplicates.

## Install

```sh
npx -y @namraks-labs/plaud-mcp --help
```

Or clone and build:

```sh
git clone https://github.com/Namraks-Labs/plaud-mcp.git
cd plaud-mcp
npm install   # runs the build automatically
```

## Authenticate

Plaud uses a JWT from your logged-in web session.

1. Log in at [web.plaud.ai](https://web.plaud.ai).
2. Open DevTools → **Network** tab. Filter by your api host (e.g. `api-euc1`). Reload the page.
3. Click any request → **Headers** → **Request Headers** → copy the value after `authorization: bearer ` (the `eyJ…` part).
4. Save it:
   ```sh
   plaud-mcp auth <jwt>
   ```

The token is a real JWT (decode it at [jwt.io](https://jwt.io) to read its expiry; observed lifetime is ~1 year). When it expires, sync fails with a clear `HTTP 401` and you repeat the steps above.

**Region:** if your account is not on the default `https://api.plaud.ai`, set your host once. EU accounts use `api-euc1`:

```sh
plaud-mcp api https://api-euc1.plaud.ai
```

You can find your host in DevTools → Console:
`localStorage.getItem("pld_plaud_user_api_domain")`.

## Use as a CLI

```sh
plaud-mcp sync                  # sync new recordings (incremental)
plaud-mcp sync --dry-run        # show what would sync, write nothing
plaud-mcp sync --force          # re-sync everything (overwrites by file id)
plaud-mcp list --limit 20       # list recordings on the cloud
plaud-mcp get <file-id>         # print one recording's markdown to stdout
plaud-mcp status                # show config + last-sync timestamp
```

## Use as an MCP server

Run with no arguments to start the stdio server. Add it to your MCP client config, e.g. Claude Desktop / Claude Code:

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
| `plaud_list` | List recordings on the cloud without syncing. Arg: `limit`. |
| `plaud_get_recording` | Fetch one recording's rendered markdown by `fileId`, without writing it. |
| `plaud_status` | Show token source, API domain, notes/state dirs, last sync. |

If you authenticated with `plaud-mcp auth`, you can omit `PLAUD_TOKEN` from the env — the server reads the saved token file.

## Configuration

Environment variables override the saved config files.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PLAUD_TOKEN` | — | JWT (alternative to `plaud-mcp auth`). |
| `PLAUD_API_DOMAIN` | `https://api.plaud.ai` | API host for your region. |
| `PLAUD_NOTES_DIR` | `~/plaud-notes` | Output directory for markdown files. |
| `PLAUD_STATE_DIR` | `~/.plaud-mcp` | Where the token, sync state, and config live. |

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

## Scheduling

Run `plaud-mcp sync` on a timer. On macOS, a launchd agent works well; on Linux, a cron job or systemd timer. Set `PLAUD_*` env vars in the job so it finds your token and output dir.

## State

- `~/.plaud-mcp/token` — JWT, `chmod 600`.
- `~/.plaud-mcp/state.json` — `{ lastSyncMs, seenIds[] }` for incremental sync.
- `~/.plaud-mcp/config.json` — saved API domain.

Delete `state.json` and run `plaud-mcp sync --force` to fully re-sync.

## License

MIT © Namraks Labs

# AGENTS.md

Operating guide for autonomous agents (and the humans configuring them) working with `plaud-mcp`. Keep it conservative: the only side effect this tool has is **writing markdown files** into `PLAUD_NOTES_DIR`. It never deletes recordings, never modifies the Plaud cloud, and never posts anywhere.

## What this tool does

Pulls Plaud recordings (summary + highlights + diarized transcript) into one markdown file each, under `PLAUD_NOTES_DIR/YYYY-MM-DD/<slug>-<id6>.md`. Sync is incremental (tracked in `state.json`) and idempotent (matched by `plaud_file_id` in frontmatter).

## Setup contract

1. **Token (required, human-in-the-loop once).** There are no API keys. A human must extract a JWT from a logged-in `web.plaud.ai` session (DevTools → Network → any api request → `authorization: bearer eyJ…`). Provide it to the tool one of two ways:
   - `PLAUD_TOKEN` env var (preferred for agents/CI), or
   - `plaud-mcp auth` (saves to `$PLAUD_STATE_DIR/token`, chmod 600). Pipe on stdin to keep it out of shell history: `pbpaste | plaud-mcp auth`.
   An agent should **not** fabricate or guess a token. If none is configured, `plaud-mcp status` reports `token source: none` — escalate to the human with the extraction steps above.
2. **Region.** Default API host is `https://api.plaud.ai`. EU accounts use `https://api-euc1.plaud.ai`. Set via `PLAUD_API_DOMAIN` or `plaud-mcp api <url>`.
3. **Output dir.** Set `PLAUD_NOTES_DIR` to where notes should land.

## Run contract

- Sync: `plaud-mcp sync` — exits `0` on success (including "0 new"), non-zero on auth/network/parse failure.
- Inspect without writing: `plaud-mcp sync --dry-run`, `plaud-mcp list`, `plaud-mcp get <file-id>`.
- Health: `plaud-mcp status` — reports token source, **token expiry in days**, api domain, dirs, last-sync time, seen-id count.

A healthy idle sync prints `N total, 0 candidate(s)` and writes nothing. Treat that as success, not a problem — silence usually means the user simply hasn't made new recordings.

## Failure modes & how to react

| Symptom | Cause | Action |
| --- | --- | --- |
| `HTTP 401` / `status` shows token `EXPIRED` | JWT expired (~1yr lifetime) or revoked | Escalate to human: re-extract JWT, run `plaud-mcp auth`. Do not retry in a loop. |
| `HTTP 429` | Rate limited | Back off several minutes, then retry once. Don't hammer. |
| `Unexpected list response from Plaud API` | Plaud changed their backend shape | This is an upstream contract change — a code fix in `src/plaud.ts` (`plaudGet` envelope unwrap or the `/file/simple/web` path). Report it; don't keep re-running. |
| Network error | Transient connectivity | Retry once; if persistent, surface to human. |

When diagnosing a quiet scheduled job, check **stdout** (the log), not just stderr — "no errors" can mean either "broken silently" or "healthy and idle". A clean `0 candidate(s)` line in stdout confirms the latter.

## Boundaries — do not

- Do not call `sync --force` casually; it re-fetches and rewrites every recording.
- Do not delete `PLAUD_NOTES_DIR` files to "fix" sync — they're matched by id and overwritten in place.
- Do not invent a token, and do not paste a real token into any channel/log/PR.
- Do not assume the default region; confirm `PLAUD_API_DOMAIN` matches the user's account.

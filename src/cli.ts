// Command-line interface. Used for first-time auth, manual syncs, and
// scheduled runs (cron/launchd). With no subcommand, index.ts launches the
// MCP server instead.

import { DEFAULT_API, saveConfig, saveToken } from "./config.js";
import { getRecording, list, status, sync } from "./core.js";
import { PlaudAuthError, PlaudRateLimitError } from "./plaud.js";

function parseFlag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i >= 0) {
    args.splice(i, 1);
    return true;
  }
  return false;
}

function parseNum(args: string[], name: string): number | undefined {
  const i = args.indexOf(name);
  if (i >= 0) {
    const v = Number(args[i + 1]);
    args.splice(i, 2);
    if (!Number.isFinite(v)) {
      console.error(`plaud-mcp: ${name} requires a number`);
      process.exit(1);
    }
    return v;
  }
  return undefined;
}

function help(): void {
  console.log(`plaud-mcp — sync Plaud Note Pro recordings into local markdown.

Run with no arguments to start the MCP server (stdio). Subcommands:

  plaud-mcp auth <jwt>            Save your Plaud web session token (chmod 600).
  plaud-mcp api <url>            Set API domain (e.g. https://api-euc1.plaud.ai).
  plaud-mcp sync [--force] [--limit N] [--dry-run]
                                 Sync new recordings (incremental by default).
  plaud-mcp list [--limit N]     List recordings on the Plaud cloud.
  plaud-mcp get <file-id>        Print a recording's markdown to stdout.
  plaud-mcp status               Show config + last-sync timestamp.
  plaud-mcp help                 Show this help.

Configuration (env overrides files):
  PLAUD_TOKEN        JWT (alternative to 'plaud-mcp auth').
  PLAUD_API_DOMAIN   API host (default ${DEFAULT_API}).
  PLAUD_NOTES_DIR    Output directory for markdown (default ~/plaud-notes).
  PLAUD_STATE_DIR    Token/state/config directory (default ~/.plaud-mcp).

First-time setup:
  1. Log in at https://web.plaud.ai
  2. DevTools → Network → filter your api host → reload → copy the
     "authorization: bearer eyJ…" value from any request.
  3. plaud-mcp auth <jwt>   (and 'plaud-mcp api <url>' if outside the default region)
  4. plaud-mcp sync
`);
}

export async function runCli(argv: string[]): Promise<void> {
  const args = [...argv];
  const cmd = args.shift();
  try {
    switch (cmd) {
      case "auth": {
        const token = args.shift();
        if (!token) {
          console.error("plaud-mcp: usage: plaud-mcp auth <jwt>");
          process.exit(1);
        }
        const path = saveToken(token);
        console.log(`plaud-mcp: token saved to ${path} (chmod 600)`);
        return;
      }
      case "api": {
        const domain = args.shift();
        if (!domain) {
          console.error("plaud-mcp: usage: plaud-mcp api <https://api-euc1.plaud.ai>");
          process.exit(1);
        }
        const clean = domain.trim().replace(/\/+$/, "");
        if (!/^https?:\/\//.test(clean)) {
          console.error("plaud-mcp: api domain must start with http(s)://");
          process.exit(1);
        }
        saveConfig({ apiDomain: clean });
        console.log(`plaud-mcp: api domain set to ${clean}`);
        return;
      }
      case "sync": {
        const force = parseFlag(args, "--force");
        const dryRun = parseFlag(args, "--dry-run");
        const limit = parseNum(args, "--limit");
        console.log("plaud-mcp: syncing…");
        const r = await sync({ force, dryRun, limit });
        console.log(
          `plaud-mcp: ${r.total} total, ${r.candidates} candidate(s)` +
            (r.dryRun ? " (dry run)" : ""),
        );
        for (const s of r.synced) console.log(`  ${s.action}: ${s.path}`);
        for (const f of r.failures) console.error(`  failed ${f.fileId}: ${f.error}`);
        if (!r.dryRun) console.log(`plaud-mcp: done. ${r.synced.length} synced.`);
        return;
      }
      case "list": {
        const limit = parseNum(args, "--limit") ?? 20;
        const r = await list({ limit });
        console.log(`plaud-mcp: ${r.total} recordings (showing ${r.items.length})`);
        for (const it of r.items)
          console.log(`  ${it.when}  ${it.title || "(untitled)"}  [${it.fileId}]`);
        return;
      }
      case "get": {
        const fileId = args.shift();
        if (!fileId) {
          console.error("plaud-mcp: usage: plaud-mcp get <file-id>");
          process.exit(1);
        }
        const r = await getRecording(fileId);
        console.log(r.body);
        return;
      }
      case "status": {
        const s = status();
        console.log(`token source: ${s.tokenSource}`);
        console.log(`api domain:   ${s.apiDomain}`);
        console.log(`notes dir:    ${s.notesDir}`);
        console.log(`state dir:    ${s.stateDir}`);
        console.log(`last sync:    ${s.lastSync}`);
        console.log(`seen ids:     ${s.seenIds}`);
        return;
      }
      case "help":
      case "--help":
      case "-h":
        help();
        return;
      default:
        console.error(`plaud-mcp: unknown command "${cmd}"`);
        help();
        process.exit(1);
    }
  } catch (e) {
    if (e instanceof PlaudAuthError || e instanceof PlaudRateLimitError) {
      console.error(`plaud-mcp: ${e.message}`);
    } else {
      console.error(`plaud-mcp: ${(e as Error).message}`);
    }
    process.exit(1);
  }
}

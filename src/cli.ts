// Command-line interface. Used for first-time auth, manual syncs, and
// scheduled runs (cron/launchd). With no subcommand, index.ts launches the
// MCP server instead.

import { DEFAULT_API, saveConfig, saveToken } from "./config.js";
import { getRecording, list, status, sync, transcribe, transcribeAll } from "./core.js";
import { decodeTokenExp } from "./jwt.js";
import { PlaudAuthError, PlaudRateLimitError } from "./plaud.js";

/** Read a token from stdin: drained pipe, or a single prompted line on a TTY. */
async function readTokenFromStdin(): Promise<string | null> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    const s = Buffer.concat(chunks).toString("utf8").trim();
    return s || null;
  }
  process.stderr.write("Paste your Plaud JWT and press Enter:\n");
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin });
  const line = await new Promise<string>((resolve) => rl.once("line", resolve));
  rl.close();
  return line.trim() || null;
}

function parseFlag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i >= 0) {
    args.splice(i, 1);
    return true;
  }
  return false;
}

function parseStr(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i >= 0) {
    const v = args[i + 1];
    args.splice(i, 2);
    if (v === undefined) {
      console.error(`plaud-mcp: ${name} requires a value`);
      process.exit(1);
    }
    return v;
  }
  return undefined;
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

  plaud-mcp auth [jwt]           Save your Plaud token (chmod 600). Omit the
                                 arg to read it from stdin / a prompt instead,
                                 e.g.  pbpaste | plaud-mcp auth
  plaud-mcp api <url>            Set API domain (e.g. https://api-euc1.plaud.ai).
  plaud-mcp sync [--force] [--limit N] [--dry-run]
                                 Sync new recordings (incremental by default).
  plaud-mcp list [--limit N] [--since DATE] [--until DATE] [--on DATE] [--title TXT]
                                 List recordings on the Plaud cloud. Filter by
                                 local date range (--since/--until, or --on for
                                 a single day; "YYYY-MM-DD" or "YYYY-MM-DD HH:MM")
                                 and/or title substring (--title).
  plaud-mcp transcribe <file-id> [--language sv] [--no-save] [--no-start]
                                 [--no-summary-wait] [--timeout N]
                                 Trigger cloud transcription + AI summary for a
                                 recording, wait, write the markdown, and (by
                                 default) save the result back to the Plaud
                                 cloud. Waits for the AI summary too (it lags
                                 the transcript); --no-summary-wait skips that.
                                 --no-save keeps it local-only. Consumes quota.
  plaud-mcp transcribe-all [--language sv] [--limit N] [--dry-run] [--no-save]
                           [--trigger-only] [--since DATE] [--until DATE]
                           [--on DATE] [--title TXT]
                                 Transcribe every recording missing a transcript
                                 or summary. Scope with the same date/title
                                 filters as 'list'. Use --dry-run first to preview.
                                 --trigger-only fires all jobs without waiting
                                 (Plaud processes them in parallel; pull later
                                 with 'transcribe <id> --no-start' or 'sync'),
                                 which is much faster for many/long recordings.
                                 Consumes Plaud quota per recording.
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
        // Token can be passed as an arg, piped on stdin, or typed at a prompt.
        // The stdin/prompt paths keep the JWT out of shell history.
        let token = args.shift();
        if (!token) token = (await readTokenFromStdin())?.trim();
        if (!token) {
          console.error(
            "plaud-mcp: no token provided.\n" +
              "  plaud-mcp auth <jwt>            (arg)\n" +
              "  pbpaste | plaud-mcp auth        (stdin — keeps it out of shell history)",
          );
          process.exit(1);
        }
        const path = saveToken(token);
        const info = decodeTokenExp(token);
        const exp = info
          ? info.expired
            ? " — but it is already EXPIRED"
            : ` — expires ${new Date(info.expMs).toISOString().slice(0, 10)} (${info.daysLeft} days)`
          : "";
        console.log(`plaud-mcp: token saved to ${path} (chmod 600)${exp}`);
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
        const on = parseStr(args, "--on");
        const since = parseStr(args, "--since") ?? on;
        const until = parseStr(args, "--until") ?? on;
        const titleContains = parseStr(args, "--title");
        const filtered = !!(since || until || titleContains);
        // Default cap of 20 for an unfiltered list; show all matches when filtering.
        const limit = parseNum(args, "--limit") ?? (filtered ? undefined : 20);
        const r = await list({ limit, since, until, titleContains });
        console.log(
          `plaud-mcp: ${r.total} recordings` +
            (filtered ? `, ${r.matched} matched filter` : "") +
            ` (showing ${r.items.length})`,
        );
        for (const it of r.items)
          console.log(`  ${it.when}  ${it.title || "(untitled)"}  [${it.fileId}]`);
        return;
      }
      case "transcribe": {
        const fileId = args.shift();
        if (!fileId) {
          console.error("plaud-mcp: usage: plaud-mcp transcribe <file-id> [--language sv] [--save] [--no-start]");
          process.exit(1);
        }
        parseFlag(args, "--save"); // accepted but now the default; consume it
        const noSave = parseFlag(args, "--no-save");
        const noStart = parseFlag(args, "--no-start");
        const noSummaryWait = parseFlag(args, "--no-summary-wait");
        const language = parseStr(args, "--language") ?? parseStr(args, "--lang");
        const summType = parseStr(args, "--summ-type");
        const timeoutSec = parseNum(args, "--timeout");
        console.log(`plaud-mcp: transcribing ${fileId}${language ? ` (language=${language})` : ""}…`);
        const r = await transcribe({
          fileId,
          language,
          summType,
          save: !noSave,
          start: !noStart,
          requireSummary: !noSummaryWait,
          timeoutMs: timeoutSec ? timeoutSec * 1000 : undefined,
          onTick: (t, ms) =>
            console.log(`  …${Math.round(ms / 1000)}s — status ${t.status} (${t.msg})`),
        });
        console.log(
          `plaud-mcp: ${r.msg === "success" || r.status === 1 ? "done" : `status ${r.status}`}: ` +
            `${r.segments} segment(s)${r.hasSummary ? " + summary" : ""}` +
            (r.path ? ` → ${r.path}` : "") +
            (r.savedToCloud ? " (saved to cloud)" : ""),
        );
        return;
      }
      case "transcribe-all": {
        const dryRun = parseFlag(args, "--dry-run");
        const noSave = parseFlag(args, "--no-save");
        const triggerOnly = parseFlag(args, "--trigger-only");
        parseFlag(args, "--save");
        const language = parseStr(args, "--language") ?? parseStr(args, "--lang");
        const summType = parseStr(args, "--summ-type");
        const limit = parseNum(args, "--limit");
        const onTa = parseStr(args, "--on");
        const since = parseStr(args, "--since") ?? onTa;
        const until = parseStr(args, "--until") ?? onTa;
        const titleContains = parseStr(args, "--title");
        const r = await transcribeAll({
          language,
          summType,
          limit,
          dryRun,
          save: !noSave,
          triggerOnly,
          since,
          until,
          titleContains,
          onItem: (item, i, total) =>
            console.log(
              `  [${i + 1}/${total}] ${triggerOnly ? "triggering" : "transcribing"} ${item.title} (${item.fileId})…`,
            ),
        });
        if (r.dryRun) {
          console.log(`plaud-mcp: ${r.candidates.length} recording(s) would be transcribed:`);
          for (const c of r.candidates)
            console.log(
              `  ${c.title}  [${c.fileId}]  needs${c.needsTranscript ? " transcript" : ""}${c.needsSummary ? " summary" : ""}`,
            );
          console.log("Run without --dry-run to process them (consumes Plaud quota).");
        } else {
          const verb = triggerOnly ? "triggered" : "processed";
          console.log(`plaud-mcp: ${verb} ${r.processed.length}/${r.candidates.length}.`);
          for (const p of r.processed)
            console.log(
              triggerOnly
                ? `  ${p.title} [${p.fileId}] — ${p.msg}`
                : `  ${p.path ?? p.fileId} — ${p.segments} segment(s)${p.hasSummary ? " + summary" : ""}${p.segments === 0 ? ` (${p.msg})` : ""}`,
            );
          for (const s of r.skipped) console.log(`  skipped ${s.title} [${s.fileId}]: ${s.reason}`);
          for (const f of r.failures) console.error(`  failed ${f.title} [${f.fileId}]: ${f.error}`);
        }
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
        console.log(`token expiry: ${s.tokenExpiry}`);
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

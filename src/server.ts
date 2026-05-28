// MCP server exposing Plaud sync operations as tools over stdio.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { getRecording, list, status, sync, transcribe, transcribeAll } from "./core.js";

export async function runServer(): Promise<void> {
  const server = new McpServer({ name: "plaud-mcp", version: "0.1.0" });

  server.registerTool(
    "plaud_sync",
    {
      title: "Sync Plaud recordings",
      description:
        "Pull new Plaud Note Pro recordings into local markdown files (one per " +
        "recording, with AI summary, highlights, and diarized transcript). " +
        "Incremental by default. Idempotent on the Plaud file id.",
      inputSchema: {
        force: z
          .boolean()
          .optional()
          .describe("Re-sync everything, overwriting existing files. Use sparingly."),
        limit: z.number().int().positive().optional().describe("Max recordings to sync."),
        dryRun: z
          .boolean()
          .optional()
          .describe("Report what would sync without writing any files."),
      },
    },
    async ({ force, limit, dryRun }) => {
      const r = await sync({ force, limit, dryRun });
      const lines: string[] = [
        `${r.total} total on cloud, ${r.candidates} candidate(s)` +
          (r.dryRun ? " (dry run — nothing written)." : `.`),
      ];
      for (const s of r.synced) lines.push(`  ${s.action}: [${s.date}] ${s.title}`);
      if (!r.dryRun && r.synced.length === 0) lines.push("  no new recordings.");
      for (const f of r.failures) lines.push(`  failed ${f.fileId}: ${f.error}`);
      return {
        content: [
          { type: "text", text: lines.join("\n") },
          { type: "text", text: JSON.stringify(r) },
        ],
      };
    },
  );

  server.registerTool(
    "plaud_list",
    {
      title: "List Plaud recordings",
      description:
        "List recordings on the Plaud cloud without syncing them. Optionally " +
        "filter by local date range and/or title substring.",
      inputSchema: {
        limit: z.number().int().positive().optional().describe("Max recordings to list."),
        since: z
          .string()
          .optional()
          .describe('Only recordings on/after this local date(time), e.g. "2026-05-26" or "2026-05-26 09:00".'),
        until: z.string().optional().describe('Only recordings on/before this local date(time).'),
        titleContains: z.string().optional().describe("Case-insensitive substring match on the recording title."),
      },
    },
    async ({ limit, since, until, titleContains }) => {
      const filtered = !!(since || until || titleContains);
      const r = await list({ limit: limit ?? (filtered ? undefined : 20), since, until, titleContains });
      const lines = [
        `${r.total} recording(s)${filtered ? `, ${r.matched} matched` : ""} (showing ${r.items.length}):`,
      ];
      for (const it of r.items) lines.push(`  ${it.when}  ${it.title || "(untitled)"}  [${it.fileId}]`);
      return {
        content: [
          { type: "text", text: lines.join("\n") },
          { type: "text", text: JSON.stringify(r) },
        ],
      };
    },
  );

  server.registerTool(
    "plaud_get_recording",
    {
      title: "Get a Plaud recording",
      description:
        "Fetch a single recording's rendered markdown (summary + transcript) by " +
        "its Plaud file id, without writing it to disk. Use plaud_list to find ids.",
      inputSchema: {
        fileId: z.string().min(1).describe("The Plaud file id of the recording."),
      },
    },
    async ({ fileId }) => {
      const r = await getRecording(fileId);
      return { content: [{ type: "text", text: r.body }] };
    },
  );

  server.registerTool(
    "plaud_transcribe",
    {
      title: "Transcribe a Plaud recording",
      description:
        "Trigger Plaud's cloud transcription + AI summary generation for a " +
        "recording that hasn't been processed yet (or re-run it), wait for it " +
        "to finish, and write the resulting markdown. Consumes Plaud " +
        "transcription quota. Use plaud_list to find file ids.",
      inputSchema: {
        fileId: z.string().min(1).describe("The Plaud file id to transcribe."),
        language: z
          .string()
          .optional()
          .describe('Language code, e.g. "sv", "en", or "auto" (default) to let Plaud detect.'),
        summType: z
          .string()
          .optional()
          .describe('Summary template (default "REASONING-NOTE", the web app default).'),
        save: z
          .boolean()
          .optional()
          .describe("Persist the result back to the Plaud cloud (default true; set false to keep it local-only)."),
        waitForSummary: z
          .boolean()
          .optional()
          .describe(
            "Wait for the AI summary too, not just the transcript (default true). " +
              "The summary task finishes after the transcript task.",
          ),
        timeoutSec: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Max seconds to wait for completion (default 600)."),
      },
    },
    async ({ fileId, language, summType, save, waitForSummary, timeoutSec }) => {
      const r = await transcribe({
        fileId,
        language,
        summType,
        save,
        requireSummary: waitForSummary,
        timeoutMs: timeoutSec ? timeoutSec * 1000 : undefined,
      });
      const text = [
        `${r.msg === "success" || r.status === 1 ? "done" : `status ${r.status} (${r.msg})`}: [${r.date}] ${r.title}`,
        `  ${r.segments} transcript segment(s)${r.hasSummary ? " + summary" : " (no summary returned)"}`,
        r.path ? `  written: ${r.path}` : "  (not written)",
        r.savedToCloud ? "  saved back to Plaud cloud" : "",
      ]
        .filter(Boolean)
        .join("\n");
      return { content: [{ type: "text", text }, { type: "text", text: JSON.stringify(r) }] };
    },
  );

  server.registerTool(
    "plaud_transcribe_all",
    {
      title: "Transcribe all unprocessed recordings",
      description:
        "Find every recording that isn't fully processed (missing a transcript " +
        "or AI summary) and transcribe each. Consumes Plaud quota per recording " +
        "— call with dryRun:true first to preview, and use limit to cap how many run.",
      inputSchema: {
        language: z.string().optional().describe('Language code (default "auto").'),
        summType: z.string().optional().describe('Summary template (default "REASONING-NOTE").'),
        limit: z.number().int().positive().optional().describe("Max recordings to process."),
        dryRun: z
          .boolean()
          .optional()
          .describe("List the recordings that would be transcribed without doing it."),
        save: z
          .boolean()
          .optional()
          .describe("Persist results back to the Plaud cloud (default true)."),
        triggerOnly: z
          .boolean()
          .optional()
          .describe(
            "Fire every job without waiting for completion (Plaud processes them " +
              "in parallel server-side). Much faster for many/long recordings; pull " +
              "the markdown later with plaud_transcribe (start:false) or plaud_sync.",
          ),
        since: z.string().optional().describe('Only recordings on/after this local date(time).'),
        until: z.string().optional().describe('Only recordings on/before this local date(time).'),
        titleContains: z.string().optional().describe("Only recordings whose title contains this substring."),
      },
    },
    async ({ language, summType, limit, dryRun, save, triggerOnly, since, until, titleContains }) => {
      const r = await transcribeAll({ language, summType, limit, dryRun, save, triggerOnly, since, until, titleContains });
      const lines: string[] = [];
      if (r.dryRun) {
        lines.push(`${r.candidates.length} recording(s) would be transcribed:`);
        for (const c of r.candidates)
          lines.push(
            `  ${c.title}  [${c.fileId}]` +
              ` — needs${c.needsTranscript ? " transcript" : ""}${c.needsSummary ? " summary" : ""}`,
          );
      } else {
        lines.push(`Processed ${r.processed.length}/${r.candidates.length} recording(s):`);
        for (const p of r.processed)
          lines.push(`  [${p.date}] ${p.title} — ${p.segments} segment(s)${p.hasSummary ? " + summary" : ""}`);
        for (const s of r.skipped) lines.push(`  skipped ${s.title} [${s.fileId}]: ${s.reason}`);
        for (const f of r.failures) lines.push(`  failed ${f.title} [${f.fileId}]: ${f.error}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }, { type: "text", text: JSON.stringify(r) }] };
    },
  );

  server.registerTool(
    "plaud_status",
    {
      title: "Plaud sync status",
      description: "Show current config: token source, API domain, notes/state dirs, last sync.",
      inputSchema: {},
    },
    async () => {
      const s = status();
      const text = [
        `token source: ${s.tokenSource}`,
        `token expiry: ${s.tokenExpiry}`,
        `api domain:   ${s.apiDomain}`,
        `notes dir:    ${s.notesDir}`,
        `state dir:    ${s.stateDir}`,
        `last sync:    ${s.lastSync}`,
        `seen ids:     ${s.seenIds}`,
      ].join("\n");
      return { content: [{ type: "text", text }, { type: "text", text: JSON.stringify(s) }] };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

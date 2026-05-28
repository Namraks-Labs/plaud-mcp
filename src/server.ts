// MCP server exposing Plaud sync operations as tools over stdio.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { getRecording, list, status, sync, transcribe } from "./core.js";

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
      description: "List recordings on the Plaud cloud without syncing them.",
      inputSchema: {
        limit: z.number().int().positive().optional().describe("Max recordings to list (default 20)."),
      },
    },
    async ({ limit }) => {
      const r = await list({ limit: limit ?? 20 });
      const lines = [`${r.total} recording(s) (showing ${r.items.length}):`];
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
          .describe("Also persist the result back to the Plaud cloud (default false)."),
        timeoutSec: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Max seconds to wait for completion (default 600)."),
      },
    },
    async ({ fileId, language, summType, save, timeoutSec }) => {
      const r = await transcribe({
        fileId,
        language,
        summType,
        save,
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

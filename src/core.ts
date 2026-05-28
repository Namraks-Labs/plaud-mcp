// Core operations shared by the MCP server and the CLI: sync, list, status, get.
// Pure data in / data out — no channel posts, no logging side-effects beyond
// writing the markdown files themselves.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  type Config,
  type State,
  NOTES_DIR,
  STATE_DIR,
  loadConfig,
  loadState,
  loadToken,
  requireToken,
  saveState,
  tokenSource,
} from "./config.js";
import { decodeTokenExp } from "./jwt.js";
import {
  type FileSummary,
  type TranscribeConfig,
  type TranssummResult,
  DEFAULT_TRANSCRIBE_CONFIG,
  getDetail,
  hydrateDetail,
  listFiles,
  saveTranscription,
  startTranscription,
  waitForTranscription,
} from "./plaud.js";
import {
  type Rendered,
  extractSummary,
  extractTranscript,
  fmtDate,
  renderMarkdown,
} from "./render.js";

const extractors = { summary: extractSummary, transcript: extractTranscript };

function startMsOf(f: FileSummary): number {
  const st = typeof f.start_time === "number" ? f.start_time : 0;
  return st > 1e12 ? st : st * 1000;
}

/** Walk NOTES_DIR for a file already carrying this plaud_file_id (idempotency). */
function findExistingFile(fileId: string): string | null {
  if (!existsSync(NOTES_DIR)) return null;
  const stack: string[] = [NOTES_DIR];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const path = join(dir, name);
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(path);
        continue;
      }
      if (!name.endsWith(".md")) continue;
      try {
        const head = readFileSync(path, "utf8").slice(0, 400);
        if (head.includes(`plaud_file_id: ${fileId}`)) return path;
      } catch {
        /* ignore unreadable files */
      }
    }
  }
  return null;
}

export type SyncedItem = {
  fileId: string;
  title: string;
  date: string;
  action: "created" | "updated";
  path: string;
  summary: string;
};

export type SyncResult = {
  total: number;
  candidates: number;
  synced: SyncedItem[];
  failures: { fileId: string; error: string }[];
  dryRun: boolean;
};

export async function sync(opts: {
  force?: boolean;
  limit?: number;
  dryRun?: boolean;
} = {}): Promise<SyncResult> {
  const token = requireToken();
  const config = loadConfig();
  const state = loadState();
  mkdirSync(NOTES_DIR, { recursive: true });

  const list = await listFiles(token, config.apiDomain);
  const seen = new Set(state.seenIds);
  const candidates = list
    .filter((f) => !f.is_trash)
    .filter((f) => {
      if (opts.force) return true;
      const id = String(f.file_id ?? f.id);
      if (seen.has(id)) return false;
      return startMsOf(f) > state.lastSyncMs;
    })
    .sort((a, b) => (a.start_time ?? 0) - (b.start_time ?? 0));

  const todo = opts.limit ? candidates.slice(0, opts.limit) : candidates;

  const result: SyncResult = {
    total: list.length,
    candidates: candidates.length,
    synced: [],
    failures: [],
    dryRun: !!opts.dryRun,
  };

  if (opts.dryRun) return result;

  let maxStartMs = state.lastSyncMs;
  for (const f of todo) {
    const id = String(f.file_id ?? f.id);
    try {
      const detailRaw = await getDetail(id, token, config.apiDomain);
      const detail = await hydrateDetail(detailRaw, extractors);
      const rendered: Rendered = renderMarkdown(detail);

      const existing = findExistingFile(rendered.fileId);
      const path = existing ?? join(NOTES_DIR, rendered.filename);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, rendered.body);

      result.synced.push({
        fileId: rendered.fileId,
        title: rendered.title,
        date: fmtDate(rendered.startMs),
        action: existing ? "updated" : "created",
        path,
        summary: rendered.summary,
      });

      seen.add(id);
      if (rendered.startMs > maxStartMs) maxStartMs = rendered.startMs;
    } catch (e) {
      result.failures.push({ fileId: id, error: (e as Error).message });
    }
  }

  state.lastSyncMs = maxStartMs;
  state.seenIds = [...seen];
  saveState(state);

  return result;
}

export type ListItem = { fileId: string; when: string; title: string };

export async function list(opts: { limit?: number } = {}): Promise<{
  total: number;
  items: ListItem[];
}> {
  const token = requireToken();
  const config = loadConfig();
  const all = await listFiles(token, config.apiDomain);
  const sorted = all
    .filter((f) => !f.is_trash)
    .sort((a, b) => (b.start_time ?? 0) - (a.start_time ?? 0));
  const show = opts.limit ? sorted.slice(0, opts.limit) : sorted;
  const items: ListItem[] = show.map((f) => {
    const ms = startMsOf(f);
    return {
      fileId: String(f.file_id ?? f.id),
      when: ms > 0 ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "?",
      title: typeof f.title === "string" ? f.title : typeof f.name === "string" ? f.name : "",
    };
  });
  return { total: all.length, items };
}

/** Fetch a single recording's rendered markdown without writing it to disk. */
export async function getRecording(fileId: string): Promise<Rendered> {
  const token = requireToken();
  const config = loadConfig();
  const detailRaw = await getDetail(fileId, token, config.apiDomain);
  const detail = await hydrateDetail(detailRaw, extractors);
  return renderMarkdown(detail);
}

function normalizeSummary(dataResultSumm: unknown): string {
  if (typeof dataResultSumm === "string") {
    const s = dataResultSumm.trim();
    if (s.startsWith("{")) {
      try {
        const parsed = JSON.parse(s) as Record<string, unknown>;
        return (
          (parsed.markdown as string) ??
          ((parsed.content as Record<string, unknown>)?.markdown as string) ??
          (parsed.summary as string) ??
          s
        );
      } catch {
        return s;
      }
    }
    return s;
  }
  if (dataResultSumm && typeof dataResultSumm === "object") {
    const o = dataResultSumm as Record<string, unknown>;
    if (typeof o.markdown === "string") return o.markdown;
    if (typeof o.summary === "string") return o.summary;
  }
  return "";
}

export type TranscribeResult = {
  fileId: string;
  title: string;
  date: string;
  status: number;
  msg: string;
  segments: number;
  hasSummary: boolean;
  path: string | null;
  savedToCloud: boolean;
};

/**
 * Trigger transcription + AI analysis for a recording, wait for it, render the
 * result to a markdown file, and optionally persist it back to the Plaud cloud.
 */
export async function transcribe(opts: {
  fileId: string;
  language?: string;
  summType?: string;
  diarization?: 0 | 1;
  start?: boolean; // PATCH the tranConfig to kick off a fresh job (default true)
  save?: boolean; // PATCH results back to the cloud (default false)
  write?: boolean; // write a markdown file locally (default true)
  timeoutMs?: number;
  onTick?: (r: TranssummResult, elapsedMs: number) => void;
}): Promise<TranscribeResult> {
  const token = requireToken();
  const config = loadConfig();
  const cfg: TranscribeConfig = {
    ...DEFAULT_TRANSCRIBE_CONFIG,
    ...(opts.language ? { language: opts.language } : {}),
    ...(opts.summType ? { summType: opts.summType } : {}),
    ...(opts.diarization !== undefined ? { diarization: opts.diarization } : {}),
  };

  // Metadata (title/date/duration) comes from the file detail.
  const detail = await getDetail(opts.fileId, token, config.apiDomain);

  if (opts.start !== false) {
    await startTranscription(opts.fileId, token, config.apiDomain, cfg);
  }

  const result = await waitForTranscription(opts.fileId, token, config.apiDomain, cfg, {
    timeoutMs: opts.timeoutMs,
    onTick: opts.onTick,
  });

  const summary = normalizeSummary(result.data_result_summ);
  const merged: Record<string, unknown> = {
    ...detail,
    transcript: Array.isArray(result.data_result) ? result.data_result : detail.transcript,
    ai_content: summary || detail.ai_content,
    summary: summary || (detail.summary as string | undefined),
  };
  const rendered = renderMarkdown(merged);

  let path: string | null = null;
  if (opts.write !== false) {
    const existing = findExistingFile(rendered.fileId);
    path = existing ?? join(NOTES_DIR, rendered.filename);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, rendered.body);
  }

  let savedToCloud = false;
  if (opts.save) {
    await saveTranscription(opts.fileId, token, config.apiDomain, result);
    savedToCloud = true;
  }

  return {
    fileId: rendered.fileId,
    title: rendered.title,
    date: fmtDate(rendered.startMs),
    status: result.status,
    msg: result.msg,
    segments: Array.isArray(result.data_result) ? result.data_result.length : 0,
    hasSummary: !!summary,
    path,
    savedToCloud,
  };
}

export type StatusInfo = {
  tokenSource: "env" | "file" | "none";
  tokenExpiry: string;
  apiDomain: string;
  notesDir: string;
  stateDir: string;
  lastSync: string;
  seenIds: number;
};

export function status(): StatusInfo {
  const state: State = loadState();
  const config: Config = loadConfig();
  const token = loadToken();
  let tokenExpiry = "(no token)";
  if (token) {
    const info = decodeTokenExp(token);
    if (!info) tokenExpiry = "(not a decodable JWT)";
    else if (info.expired) tokenExpiry = `EXPIRED (${new Date(info.expMs).toISOString().slice(0, 10)})`;
    else tokenExpiry = `${new Date(info.expMs).toISOString().slice(0, 10)} (${info.daysLeft} days left)`;
  }
  return {
    tokenSource: tokenSource(),
    tokenExpiry,
    apiDomain: config.apiDomain,
    notesDir: NOTES_DIR,
    stateDir: STATE_DIR,
    lastSync: state.lastSyncMs ? new Date(state.lastSyncMs).toISOString() : "(never)",
    seenIds: state.seenIds.length,
  };
}

// Minimal client for the (undocumented) Plaud cloud API.
//
// There is no official public Plaud API. This talks to the same backend the
// web app (web.plaud.ai) uses, reverse-engineered from observed traffic — the
// same approach as the leonardsellem/plaud-sync-for-obsidian plugin. It may
// break without notice if Plaud changes their backend.

// Cloudflare in front of the api hosts 403s requests with non-browser UA
// strings, so we present a normal browser UA + Origin/Referer matching the web
// app to pass the WAF.
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export class PlaudAuthError extends Error {}
export class PlaudRateLimitError extends Error {}

export type FileSummary = {
  id: string;
  file_id?: string;
  is_trash?: boolean;
  is_trans?: boolean; // transcript has been generated
  is_summary?: boolean; // AI summary has been generated
  start_time?: number;
  filename?: string;
  fullname?: string;
  [k: string]: unknown;
};

/** GET a Plaud API path and unwrap the common response envelopes. */
export async function plaudGet<T>(
  path: string,
  token: string,
  apiDomain: string,
): Promise<T> {
  const res = await fetch(`${apiDomain}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": BROWSER_UA,
      Origin: "https://web.plaud.ai",
      Referer: "https://web.plaud.ai/",
      Accept: "application/json, text/plain, */*",
    },
  });
  if (res.status === 401 || res.status === 403) {
    throw new PlaudAuthError(
      `Token expired or invalid (HTTP ${res.status}). Re-extract the JWT from ` +
        "web.plaud.ai (DevTools → Network → any api request → " +
        '"authorization: bearer eyJ…") and run:  plaud-mcp auth <jwt>',
    );
  }
  if (res.status === 429) {
    throw new PlaudRateLimitError("Rate limited (HTTP 429). Try again later.");
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${path}`);
  const json = await res.json();
  if (Array.isArray(json)) return json as T;
  const env = json as Record<string, unknown>;
  if ("payload" in env && env.payload !== undefined) return env.payload as T;
  if ("data_file_list" in env && env.data_file_list !== undefined)
    return env.data_file_list as T;
  if ("data" in env && env.data !== undefined) return env.data as T;
  return json as T;
}

/** POST/PATCH a Plaud API path with a JSON body, unwrapping the same envelopes. */
async function plaudWrite<T>(
  method: "POST" | "PATCH",
  path: string,
  token: string,
  apiDomain: string,
  body: Record<string, unknown>,
): Promise<T> {
  // Plaud adds a random cache-buster `r` to every mutating request.
  const payload = { ...body, r: Math.random() };
  const res = await fetch(`${apiDomain}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": BROWSER_UA,
      Origin: "https://web.plaud.ai",
      Referer: "https://web.plaud.ai/",
      "Content-Type": "application/json",
      Accept: "application/json, text/plain, */*",
    },
    body: JSON.stringify(payload),
  });
  if (res.status === 401 || res.status === 403) {
    throw new PlaudAuthError(
      `Token expired or invalid (HTTP ${res.status}). Re-extract the JWT and run:  plaud-mcp auth <jwt>`,
    );
  }
  if (res.status === 429) {
    throw new PlaudRateLimitError("Rate limited (HTTP 429). Try again later.");
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${method} ${path}`);
  const json = await res.json();
  // Region-mismatch surfaces as a 200 with a negative status code.
  if (json && typeof json === "object") {
    const env = json as Record<string, unknown>;
    if (env.status === -302 || env.msg === "user region mismatch") {
      throw new Error(
        "Plaud API region mismatch — set the correct host with: plaud-mcp api <https://api-…plaud.ai>",
      );
    }
  }
  return json as T;
}

export type TranscribeConfig = {
  /** Language code, e.g. "sv", "en", or "auto" to let Plaud detect. */
  language: string;
  /** Summary template. "REASONING-NOTE" is the web app's default. */
  summType: string;
  /** Whether to run speaker diarization (1 = on). */
  diarization: 0 | 1;
  /** LLM selection; "auto" lets Plaud choose. */
  llm: string;
};

export const DEFAULT_TRANSCRIBE_CONFIG: TranscribeConfig = {
  language: "auto",
  summType: "REASONING-NOTE",
  diarization: 1,
  llm: "auto",
};

/**
 * Kick off transcription + AI analysis for a recording.
 *
 * The actual trigger is POST /ai/transsumm/{id} with `is_reload: 1` (verified
 * against a live account: it flips ppc_status/is_trans and starts the job).
 * `is_reload: 0` — what the polling path uses — is a read-only status check and
 * does NOT start anything.
 */
export async function startTranscription(
  fileId: string,
  token: string,
  apiDomain: string,
  cfg: TranscribeConfig,
): Promise<Record<string, unknown>> {
  return plaudWrite("POST", `/ai/transsumm/${encodeURIComponent(fileId)}`, token, apiDomain, {
    is_reload: 1,
    summ_type: cfg.summType,
    summ_type_type: "system",
    info: JSON.stringify({
      language: cfg.language,
      diarization: cfg.diarization,
      llm: cfg.llm,
    }),
    support_mul_summ: true,
  });
}

export type TranssummResult = {
  complete: boolean; // transcript is ready
  summaryReady: boolean; // AI summary is ready
  status: number;
  msg: string;
  data_result?: unknown;
  data_result_summ?: unknown;
  outline_result?: unknown;
  task_id_info?: unknown;
  raw: Record<string, unknown>;
};

/** True when data_result_summ carries actual summary content (string or object). */
function summaryIsReady(v: unknown): boolean {
  if (typeof v === "string") return v.trim().length > 0;
  if (v && typeof v === "object") return Object.keys(v as object).length > 0;
  return false;
}

/** Poll the analysis status/result for a recording (one call). */
export async function getTranssumm(
  fileId: string,
  token: string,
  apiDomain: string,
  cfg: TranscribeConfig,
): Promise<TranssummResult> {
  const raw = await plaudWrite<Record<string, unknown>>(
    "POST",
    `/ai/transsumm/${encodeURIComponent(fileId)}`,
    token,
    apiDomain,
    {
      is_reload: 0,
      summ_type: cfg.summType,
      summ_type_type: "system",
      info: JSON.stringify({
        language: cfg.language,
        diarization: cfg.diarization,
        llm: cfg.llm,
      }),
      support_mul_summ: true,
    },
  );
  const status = typeof raw.status === "number" ? raw.status : -1;
  const msg = typeof raw.msg === "string" ? raw.msg : "";
  // The transcript is ready once data_result is a populated array. `status`
  // stays 0 while the transcript is ready but the summary is still generating,
  // and only flips to 1 once the summary lands — so don't gate completion on it.
  const hasResult = Array.isArray(raw.data_result) && raw.data_result.length > 0;
  const complete = hasResult;
  return {
    complete,
    summaryReady: summaryIsReady(raw.data_result_summ),
    status,
    msg,
    data_result: raw.data_result,
    data_result_summ: raw.data_result_summ,
    outline_result: raw.outline_result,
    task_id_info: raw.task_id_info,
    raw,
  };
}

/**
 * Poll until analysis completes (or timeout). Calls onTick after each poll.
 *
 * The transcript task finishes before the AI summary task. When
 * `requireSummary` is set (the default), we keep polling after the transcript
 * lands until the summary appears too — but if the overall timeout is hit with
 * a transcript-but-no-summary, we return that partial result rather than
 * throwing (some recordings legitimately never get a summary).
 */
export async function waitForTranscription(
  fileId: string,
  token: string,
  apiDomain: string,
  cfg: TranscribeConfig,
  opts: {
    timeoutMs?: number;
    intervalMs?: number;
    requireSummary?: boolean;
    onTick?: (r: TranssummResult, elapsedMs: number) => void;
  } = {},
): Promise<TranssummResult> {
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const intervalMs = opts.intervalMs ?? 10_000;
  const requireSummary = opts.requireSummary ?? true;
  const start = Date.now();
  let last: TranssummResult | null = null;
  while (Date.now() - start < timeoutMs) {
    last = await getTranssumm(fileId, token, apiDomain, cfg);
    opts.onTick?.(last, Date.now() - start);
    if (last.complete && (!requireSummary || last.summaryReady)) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  // Timed out. If we at least got a transcript, return that partial result.
  if (last && last.complete) return last;
  throw new Error(
    `Transcription for ${fileId} did not complete within ${Math.round(timeoutMs / 1000)}s` +
      (last ? ` (last status: ${last.status}, msg: "${last.msg}")` : ""),
  );
}

/** Persist analysis results back to the recording on the Plaud cloud. */
export async function saveTranscription(
  fileId: string,
  token: string,
  apiDomain: string,
  result: TranssummResult,
): Promise<Record<string, unknown>> {
  const raw = result.raw;
  let aiContent: unknown = raw.data_result_summ ?? "";
  let aiContentHeader: unknown = {};
  if (typeof aiContent === "string" && aiContent.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(aiContent) as Record<string, unknown>;
      aiContent =
        (parsed.markdown as string) ??
        ((parsed.content as Record<string, unknown>)?.markdown as string) ??
        (parsed.summary as string) ??
        aiContent;
      aiContentHeader = parsed.header ?? {};
    } catch {
      /* leave as-is */
    }
  }
  return plaudWrite("PATCH", `/file/${encodeURIComponent(fileId)}`, token, apiDomain, {
    trans_result: raw.data_result ?? [],
    ai_content: aiContent,
    outline_result: raw.outline_result ?? [],
    support_mul_summ: true,
    extra_data: { task_id_info: raw.task_id_info ?? {}, aiContentHeader },
  });
}

/** Fetch a signed (pre-authenticated) content URL; returns parsed JSON or raw text. */
export async function fetchSigned(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { "User-Agent": BROWSER_UA, Accept: "application/json, text/plain, */*" },
  });
  if (!res.ok) return null;
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function listFiles(
  token: string,
  apiDomain: string,
): Promise<FileSummary[]> {
  const list = await plaudGet<FileSummary[]>("/file/simple/web", token, apiDomain);
  if (!Array.isArray(list)) throw new Error("Unexpected list response from Plaud API");
  return list;
}

export async function getDetail(
  id: string,
  token: string,
  apiDomain: string,
): Promise<Record<string, unknown>> {
  return plaudGet<Record<string, unknown>>(
    `/file/detail/${encodeURIComponent(id)}`,
    token,
    apiDomain,
  );
}

function pickContentLink(detail: Record<string, unknown>, dataType: string): string {
  const list = Array.isArray(detail.content_list) ? detail.content_list : [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const it = item as Record<string, unknown>;
    const type = String(
      it.data_type ?? it.type ?? it.label ?? it.name ?? "",
    ).toLowerCase();
    if (type === dataType.toLowerCase()) {
      const link = it.data_link ?? it.link ?? it.url;
      if (typeof link === "string" && link.trim()) return link;
    }
  }
  return "";
}

/** Pull summary/transcript from signed content links when not inline on the detail. */
export async function hydrateDetail(
  detail: Record<string, unknown>,
  extract: { summary: (d: Record<string, unknown>) => string; transcript: (d: Record<string, unknown>) => string },
): Promise<Record<string, unknown>> {
  const out = { ...detail };
  if (!extract.summary(out)) {
    const link = pickContentLink(out, "auto_sum_note");
    if (link) {
      const content = await fetchSigned(link);
      if (content) applySummary(out, content);
    }
  }
  if (!extract.transcript(out)) {
    const link = pickContentLink(out, "transaction");
    if (link) {
      const content = await fetchSigned(link);
      if (content) applyTranscript(out, content);
    }
  }
  return out;
}

function applySummary(out: Record<string, unknown>, content: unknown): void {
  if (typeof content === "string") {
    try {
      applySummary(out, JSON.parse(content));
    } catch {
      out.summary = content;
    }
    return;
  }
  if (!content || typeof content !== "object") return;
  const c = content as Record<string, unknown>;
  for (const key of ["ai_content", "summary", "abstract", "content", "text"]) {
    const v = c[key];
    if (typeof v === "string" && v.trim()) {
      out.summary = v;
      break;
    }
  }
  if (!out.ai_content || typeof out.ai_content !== "object") out.ai_content = {};
  const ai = out.ai_content as Record<string, unknown>;
  for (const key of ["summary", "highlights", "key_points", "abstract", "content"]) {
    if (key in c && !(key in ai)) ai[key] = c[key];
  }
}

function applyTranscript(out: Record<string, unknown>, content: unknown): void {
  if (typeof content === "string") {
    try {
      applyTranscript(out, JSON.parse(content));
    } catch {
      out.transcript_text = content;
    }
    return;
  }
  if (Array.isArray(content)) {
    out.transcript = content;
    return;
  }
  if (content && typeof content === "object") {
    out.trans_result = content;
  }
}

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
  start_time?: number;
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

// Turn a Plaud recording "detail" object into a stable markdown document.
//
// The Plaud API returns wildly inconsistent shapes across accounts, regions,
// and recording ages, so every extractor probes several candidate keys.

function renderSpeakerArray(items: unknown[]): string {
  // Collapse consecutive utterances from the same speaker into one paragraph.
  const blocks: { speaker: string; texts: string[] }[] = [];
  for (const item of items) {
    if (typeof item === "string") {
      blocks.push({ speaker: "", texts: [item] });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const text = String(r.content ?? r.text ?? "").trim();
    if (!text) continue;
    const speaker =
      (typeof r.speaker === "string" && r.speaker.trim()) ||
      (typeof r.original_speaker === "string" && r.original_speaker.trim()) ||
      (typeof r.spk === "number" ? `Speaker ${r.spk}` : "") ||
      "";
    const last = blocks[blocks.length - 1];
    if (last && last.speaker === speaker) last.texts.push(text);
    else blocks.push({ speaker, texts: [text] });
  }
  return blocks
    .map((b) => (b.speaker ? `**${b.speaker}:** ${b.texts.join(" ")}` : b.texts.join(" ")))
    .join("\n\n");
}

export function extractTranscript(detail: Record<string, unknown>): string {
  if (typeof detail.transcript_text === "string" && detail.transcript_text.trim())
    return detail.transcript_text;
  if (typeof detail.full_text === "string" && detail.full_text.trim())
    return detail.full_text;
  if (Array.isArray(detail.transcript) && detail.transcript.length > 0)
    return renderSpeakerArray(detail.transcript);
  const tr = detail.trans_result;
  if (tr && typeof tr === "object") {
    const t = tr as Record<string, unknown>;
    if (typeof t.full_text === "string" && t.full_text.trim()) return t.full_text;
    if (Array.isArray(t.paragraphs) && t.paragraphs.length)
      return renderSpeakerArray(t.paragraphs);
    if (Array.isArray(t.sentences) && t.sentences.length)
      return renderSpeakerArray(t.sentences);
  }
  return "";
}

export function extractSummary(detail: Record<string, unknown>): string {
  if (typeof detail.summary === "string" && detail.summary.trim()) return detail.summary;
  const ai = detail.ai_content;
  if (ai && typeof ai === "object") {
    const a = ai as Record<string, unknown>;
    for (const key of ["summary", "abstract", "ai_content", "content"]) {
      const v = a[key];
      if (typeof v === "string" && v.trim()) return v;
    }
  }
  return "";
}

export function extractHighlights(detail: Record<string, unknown>): string[] {
  const ai = detail.ai_content;
  if (ai && typeof ai === "object") {
    const a = ai as Record<string, unknown>;
    for (const key of ["highlights", "key_points", "keypoints"]) {
      const v = a[key];
      if (Array.isArray(v)) {
        return v
          .map((x) =>
            typeof x === "string"
              ? x
              : x && typeof x === "object" && typeof (x as any).text === "string"
                ? (x as any).text
                : "",
          )
          .filter(Boolean);
      }
    }
  }
  return [];
}

export function extractTitle(detail: Record<string, unknown>): string {
  for (const key of ["title", "name", "file_name", "filename"]) {
    const v = detail[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "Untitled";
}

export function getStartMs(detail: Record<string, unknown>): number {
  const st = detail.start_time;
  if (typeof st === "number") return st > 1e12 ? st : st * 1000;
  const ct = detail.create_time ?? detail.created_at;
  if (typeof ct === "number") return ct > 1e12 ? ct : ct * 1000;
  return Date.now();
}

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "untitled"
  );
}

export function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The recording's UTC offset in minutes, derived from Plaud's `timezone`
 * (whole hours) + `zonemins` (extra minutes) fields. Plaud timestamps are UTC
 * epochs; these fields carry the local zone the recording was made in (e.g.
 * timezone:2, zonemins:0 → +120 for CEST). Returns 0 (UTC) when absent.
 */
export function getTzOffsetMin(detail: Record<string, unknown>): number {
  const tz = typeof detail.timezone === "number" ? detail.timezone : 0;
  const zm = typeof detail.zonemins === "number" ? detail.zonemins : 0;
  return tz * 60 + zm;
}

/** Local calendar date (YYYY-MM-DD) for a UTC epoch given a UTC offset in minutes. */
export function fmtLocalDate(ms: number, offsetMin: number): string {
  return new Date(ms + offsetMin * 60_000).toISOString().slice(0, 10);
}

/** ISO timestamp in the recording's local zone, e.g. 2026-05-28T10:15:00+02:00. */
export function fmtLocalIso(ms: number, offsetMin: number): string {
  const local = new Date(ms + offsetMin * 60_000).toISOString().replace(/\.\d{3}Z$/, "");
  const sign = offsetMin < 0 ? "-" : "+";
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${local}${sign}${hh}:${mm}`;
}

/** Local "YYYY-MM-DD HH:MM" for display (lists), given a UTC offset in minutes. */
export function fmtLocalDateTime(ms: number, offsetMin: number): string {
  return new Date(ms + offsetMin * 60_000).toISOString().slice(0, 16).replace("T", " ");
}

export type Rendered = {
  filename: string;
  body: string;
  summary: string;
  fileId: string;
  startMs: number;
  offsetMin: number;
  date: string; // local calendar date (YYYY-MM-DD)
  title: string;
};

export function renderMarkdown(detail: Record<string, unknown>): Rendered {
  const fileId = String(detail.file_id ?? detail.id ?? "");
  const title = extractTitle(detail);
  const startMs = getStartMs(detail);
  const offsetMin = getTzOffsetMin(detail);
  const date = fmtLocalDate(startMs, offsetMin);
  const summary = extractSummary(detail);
  const transcript = extractTranscript(detail);
  const highlights = extractHighlights(detail);
  const rawDuration = typeof detail.duration === "number" ? detail.duration : undefined;
  // Plaud reports duration in milliseconds on some hosts; normalise to seconds.
  const duration =
    rawDuration !== undefined
      ? rawDuration > 36000
        ? Math.round(rawDuration / 1000)
        : rawDuration
      : undefined;
  const lang = typeof detail.language === "string" ? detail.language : "";

  const fm = [
    "---",
    `plaud_file_id: ${fileId}`,
    `title: ${JSON.stringify(title)}`,
    `date: ${fmtLocalIso(startMs, offsetMin)}`,
    duration !== undefined ? `duration_sec: ${duration}` : null,
    lang ? `language: ${lang}` : null,
    "source: plaud",
    "---",
  ]
    .filter(Boolean)
    .join("\n");

  const parts = [fm, "", `# ${title}`, ""];
  if (summary) parts.push("## Summary", "", summary, "");
  if (highlights.length) {
    parts.push("## Highlights", "");
    for (const h of highlights) parts.push(`- ${h}`);
    parts.push("");
  }
  if (transcript) parts.push("## Transcript", "", transcript, "");

  const filename = `${date}/${slugify(title)}-${fileId.slice(-6)}.md`;
  return { filename, body: parts.join("\n"), summary, fileId, startMs, offsetMin, date, title };
}

export function shortSummary(s: string, limit = 400): string {
  const flat = s.replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  return flat.slice(0, limit - 1) + "…";
}

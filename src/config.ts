// Configuration, token, and sync-state handling for plaud-mcp.
//
// Everything is resolved from environment variables first, falling back to
// files under the state directory. This keeps the server usable both as a
// long-lived MCP process (env-configured) and as a one-shot CLI (file-configured).

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();

export const DEFAULT_API = "https://api.plaud.ai";

/** Directory holding the token, sync state, and persisted config. */
export const STATE_DIR =
  process.env.PLAUD_STATE_DIR?.trim() || join(HOME, ".plaud-mcp");

/** Where markdown notes are written, one dated folder per recording day. */
export const NOTES_DIR =
  process.env.PLAUD_NOTES_DIR?.trim() || join(HOME, "plaud-notes");

const TOKEN_FILE = join(STATE_DIR, "token");
const STATE_FILE = join(STATE_DIR, "state.json");
const CONFIG_FILE = join(STATE_DIR, "config.json");

export type State = { lastSyncMs: number; seenIds: string[] };
export type Config = { apiDomain: string };

export function ensureDir(p: string): void {
  mkdirSync(p, { recursive: true });
}

function stripBearer(token: string): string {
  return token.trim().replace(/^bearer\s+/i, "");
}

/** Resolve the API domain: env override wins, then the persisted config file. */
export function loadConfig(): Config {
  const envDomain = process.env.PLAUD_API_DOMAIN?.trim();
  if (envDomain) return { apiDomain: envDomain.replace(/\/+$/, "") };
  if (!existsSync(CONFIG_FILE)) return { apiDomain: DEFAULT_API };
  try {
    const c = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as Partial<Config>;
    return { apiDomain: (c.apiDomain ?? DEFAULT_API).replace(/\/+$/, "") };
  } catch {
    return { apiDomain: DEFAULT_API };
  }
}

export function saveConfig(c: Config): void {
  ensureDir(STATE_DIR);
  writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2));
}

/** Resolve the JWT: PLAUD_TOKEN env wins, else the token file. */
export function loadToken(): string | null {
  const envToken = process.env.PLAUD_TOKEN?.trim();
  if (envToken) return stripBearer(envToken);
  if (!existsSync(TOKEN_FILE)) return null;
  return stripBearer(readFileSync(TOKEN_FILE, "utf8"));
}

export function requireToken(): string {
  const token = loadToken();
  if (!token) {
    throw new Error(
      "No Plaud token configured.\n" +
        "  1. Log in at https://web.plaud.ai\n" +
        '  2. DevTools → Network → filter your api host → reload → copy the\n' +
        '     "authorization: bearer eyJ…" value from any request.\n' +
        "  3. Run:  plaud-mcp auth <jwt>   (or set the PLAUD_TOKEN env var)",
    );
  }
  return token;
}

export function saveToken(token: string): string {
  ensureDir(STATE_DIR);
  const clean = stripBearer(token);
  writeFileSync(TOKEN_FILE, clean);
  chmodSync(TOKEN_FILE, 0o600);
  return TOKEN_FILE;
}

export function hasTokenFile(): boolean {
  return existsSync(TOKEN_FILE);
}

export function tokenSource(): "env" | "file" | "none" {
  if (process.env.PLAUD_TOKEN?.trim()) return "env";
  if (existsSync(TOKEN_FILE)) return "file";
  return "none";
}

export function loadState(): State {
  if (!existsSync(STATE_FILE)) return { lastSyncMs: 0, seenIds: [] };
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
    return { lastSyncMs: s.lastSyncMs ?? 0, seenIds: s.seenIds ?? [] };
  } catch {
    return { lastSyncMs: 0, seenIds: [] };
  }
}

export function saveState(s: State): void {
  ensureDir(STATE_DIR);
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

export const paths = { STATE_DIR, NOTES_DIR, TOKEN_FILE, STATE_FILE, CONFIG_FILE };

// Tiny, dependency-free JWT introspection. We never verify signatures (we
// can't — it's Plaud's key); we only read the `exp` claim to surface how long
// a saved token has left, which is the single most useful piece of token
// health information for this tool.

export type TokenInfo = { expMs: number; daysLeft: number; expired: boolean };

function b64urlDecode(s: string): string {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return Buffer.from(b64, "base64").toString("utf8");
}

/** Decode a JWT's `exp` claim. Returns null if the token isn't a decodable JWT. */
export function decodeTokenExp(token: string, nowMs: number = Date.now()): TokenInfo | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(b64urlDecode(parts[1])) as { exp?: number };
    if (typeof payload.exp !== "number") return null;
    const expMs = payload.exp > 1e12 ? payload.exp : payload.exp * 1000;
    const daysLeft = Math.round((expMs - nowMs) / 86_400_000);
    return { expMs, daysLeft, expired: expMs <= nowMs };
  } catch {
    return null;
  }
}

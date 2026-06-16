export type Decision = "approve" | "deny";

/** Cryptographically-random token for the double-submit CSRF cookie. */
export function generateCsrfToken(): string {
  return crypto.randomUUID() + crypto.randomUUID().replaceAll("-", "");
}

/** Constant-time equality; false unless both are non-empty and identical. */
export function csrfTokensMatch(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function parseDecision(raw: string | null | undefined): Decision | null {
  return raw === "approve" || raw === "deny" ? raw : null;
}

export type EntryAction = "exchange-code" | "show-consent" | "begin-signin";

/** First action for the GET entry route, by precedence. */
export function chooseEntryAction(opts: { hasCode: boolean; authenticated: boolean }): EntryAction {
  if (opts.hasCode) return "exchange-code";
  if (opts.authenticated) return "show-consent";
  return "begin-signin";
}

export type Decision = "approve" | "deny";

/** Split a space-separated OAuth scope string into a clean list. */
export function parseScopes(scope: string | null | undefined): string[] {
  return (scope ?? "").split(/\s+/).filter(Boolean);
}

/** Accept only the two valid consent decisions; everything else is null. */
export function parseDecision(raw: unknown): Decision | null {
  return raw === "approve" || raw === "deny" ? raw : null;
}

/**
 * getAuthorizationDetails returns one of two shapes:
 *   - consent details (has `authorization_id`) -> show the consent screen
 *   - an already-consented redirect (has `redirect_url`) -> redirect immediately
 * Narrow to the consent-details shape.
 */
export function isConsentDetails<T extends object>(
  data: T,
): data is T & { authorization_id: string } {
  return (
    "authorization_id" in data &&
    typeof (data as Record<string, unknown>).authorization_id === "string"
  );
}

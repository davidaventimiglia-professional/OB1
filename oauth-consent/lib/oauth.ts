import type { OAuthAuthorizationDetails } from "@supabase/supabase-js";

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
 * Narrow to the consent-details shape so that `data.client` and `data.scope`
 * are accessible after the guard.
 */
export function isConsentDetails(
  data: object,
): data is OAuthAuthorizationDetails {
  return (
    "authorization_id" in data &&
    typeof (data as Record<string, unknown>).authorization_id === "string"
  );
}

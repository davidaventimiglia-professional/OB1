import { Hono } from "hono";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { createServerClient, parseCookieHeader } from "@supabase/ssr";
import { consentPage, errorPage, signInPage } from "./consent_page.ts";
import { csrfTokensMatch, generateCsrfToken, parseDecision } from "./decision.ts";

const PUBLIC_PATH = "/functions/v1/oauth-consent";

function entryUrl(origin: string, authorizationId: string): string {
  return `${origin}${PUBLIC_PATH}?authorization_id=${encodeURIComponent(authorizationId)}`;
}

function makeClient(c: Context) {
  return createServerClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    {
      cookies: {
        getAll() {
          return parseCookieHeader(c.req.header("Cookie") ?? "") as { name: string; value: string }[];
        },
        setAll(cookiesToSet) {
          for (const { name, value, options } of cookiesToSet) {
            // deno-lint-ignore no-explicit-any
            setCookie(c, name, value, options as any);
          }
        },
      },
    },
  );
}

export const app = new Hono();

async function handleEntry(c: Context) {
  const url = new URL(c.req.url);
  const authorizationId = url.searchParams.get("authorization_id");
  const code = url.searchParams.get("code");
  if (!authorizationId) return c.html(errorPage("Missing authorization_id."), 400);

  const supabase = makeClient(c);

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      return c.html(
        errorPage("Sign-in failed. Please try again.", { retryUrl: entryUrl(url.origin, authorizationId) }),
        400,
      );
    }
  }

  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "github",
      options: { redirectTo: entryUrl(url.origin, authorizationId), skipBrowserRedirect: true },
    });
    if (error || !data?.url) return c.html(errorPage("Could not start sign-in."), 502);
    return c.html(signInPage(data.url, "this application"));
  }

  const { data: details, error } = await supabase.auth.oauth.getAuthorizationDetails(authorizationId);
  if (error || !details) {
    return c.html(errorPage("This authorization request has expired or is invalid."), 400);
  }
  if (!("authorization_id" in details)) {
    return c.redirect(details.redirect_url, 302); // already consented
  }

  const csrf = generateCsrfToken();
  setCookie(c, "csrf", csrf, { path: PUBLIC_PATH, httpOnly: true, secure: true, sameSite: "Lax" });
  const scopes = (details.scope ?? "").split(/\s+/).filter(Boolean);
  return c.html(consentPage({
    clientName: details.client.name,
    scopes,
    authorizationId,
    csrfToken: csrf,
  }));
}

async function handleDecision(c: Context) {
  const body = await c.req.parseBody();
  const authorizationId = typeof body["authorization_id"] === "string" ? body["authorization_id"] : "";
  const decision = parseDecision(typeof body["decision"] === "string" ? body["decision"] : null);
  const formCsrf = typeof body["csrf"] === "string" ? body["csrf"] : undefined;
  if (!authorizationId || !decision) return c.html(errorPage("Invalid request."), 400);

  if (!csrfTokensMatch(formCsrf, getCookie(c, "csrf"))) {
    return c.html(errorPage("Security check failed. Please reload and try again."), 403);
  }

  const supabase = makeClient(c);
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) {
    return c.redirect(entryUrl(new URL(c.req.url).origin, authorizationId), 302);
  }

  const result = decision === "approve"
    ? await supabase.auth.oauth.approveAuthorization(authorizationId, { skipBrowserRedirect: true })
    : await supabase.auth.oauth.denyAuthorization(authorizationId, { skipBrowserRedirect: true });

  if (result.error || !result.data?.redirect_url) {
    return c.html(errorPage("Could not record your decision."), 502);
  }
  return c.redirect(result.data.redirect_url, 302);
}

// Deployed functions see the full public path; bare paths cover `supabase functions serve`.
app.get(PUBLIC_PATH, handleEntry);
app.get("/oauth-consent", handleEntry);
app.post(`${PUBLIC_PATH}/decision`, handleDecision);
app.post("/oauth-consent/decision", handleDecision);

if (import.meta.main) Deno.serve(app.fetch);

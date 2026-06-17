# OAuth Consent Edge Function Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Supabase Edge Function that renders the OAuth 2.1 consent screen — GitHub login via PKCE, then approve/deny — completing prerequisite #2 of the resource-server cutover.

**Architecture:** A standalone Deno/Hono Edge Function `oauth-consent`, separate from `open-brain-mcp`, with `verify_jwt = false`. It authenticates the user via `signInWithOAuth({provider:'github'})` using `@supabase/ssr`'s cookie-backed server client (PKCE), then drives the Supabase OAuth-server consent API (`auth.oauth.getAuthorizationDetails` / `approveAuthorization` / `denyAuthorization`). Any authenticated user may consent; per-user RLS isolates each tenant's brain.

**Tech Stack:** Deno, Hono 4.9.2, `@supabase/ssr` 0.12.0, `@supabase/supabase-js` 2.108.2 (auth-js 2.108.2 exposes `auth.oauth.*`), Deno's built-in test runner.

**Spec:** `docs/superpowers/specs/2026-06-16-oauth-consent-edge-function-design.md`

---

## File Structure

All new files live under a new top-level `oauth-consent/` directory (parallel to `server/`):

- `oauth-consent/deno.json` — import map (hono, ssr, supabase-js).
- `oauth-consent/decision.ts` — **pure** helpers: CSRF token generate/compare, decision parsing, entry-branch selection. No Supabase/Hono imports.
- `oauth-consent/consent_page.ts` — **pure** HTML rendering: `escapeHtml`, sign-in landing, consent screen, error page. No Supabase/Hono imports.
- `oauth-consent/index.ts` — Hono app: `@supabase/ssr` server-client factory + cookie adapter, the GET entry route and POST `/decision` route. Exports `app`; only serves when run as main.
- `oauth-consent/decision_test.ts` — Deno tests for `decision.ts`.
- `oauth-consent/consent_page_test.ts` — Deno tests for `consent_page.ts`.
- `oauth-consent/index_test.ts` — Deno test for the no-Supabase routing path (missing `authorization_id` → 400).
- `oauth-consent/deps_test.ts` — Deno test asserting the pinned client exposes `auth.oauth.*`.
- `oauth-consent/README.md`, `oauth-consent/metadata.json` — contribution conventions.

Deploy seam (gitignored, created in Task 6): `supabase/functions/oauth-consent` → symlink to `../../oauth-consent`; `supabase/config.toml` gets `[functions.oauth-consent] verify_jwt = false`.

**Routing note:** deployed Supabase functions in this project receive the **full public path** (see `server/index.ts:549`), so Hono routes are registered at `/functions/v1/oauth-consent`. We also register the bare `/oauth-consent` forms so `supabase functions serve` works locally.

---

### Task 1: Scaffold + pin dependencies + verify `auth.oauth.*`

**Files:**
- Create: `oauth-consent/deno.json`
- Test: `oauth-consent/deps_test.ts`

- [ ] **Step 1: Create the import map**

`oauth-consent/deno.json`:

```json
{
  "imports": {
    "hono": "npm:hono@4.9.2",
    "@supabase/supabase-js": "npm:@supabase/supabase-js@2.108.2",
    "@supabase/ssr": "npm:@supabase/ssr@0.12.0"
  }
}
```

- [ ] **Step 2: Write the failing dependency probe test**

`oauth-consent/deps_test.ts`:

```ts
import { assertEquals } from "jsr:@std/assert@1";
import { createServerClient } from "@supabase/ssr";

Deno.test("pinned client exposes auth.oauth.* consent methods", () => {
  const client = createServerClient(
    "https://example.supabase.co",
    "anon-key",
    { cookies: { getAll: () => [], setAll: () => {} } },
  );
  assertEquals(typeof client.auth.oauth.getAuthorizationDetails, "function");
  assertEquals(typeof client.auth.oauth.approveAuthorization, "function");
  assertEquals(typeof client.auth.oauth.denyAuthorization, "function");
});
```

- [ ] **Step 3: Run the test**

Run: `cd oauth-consent && deno test deps_test.ts --allow-net --allow-env --allow-read`
Expected: PASS (Deno downloads the npm deps on first run, then all three assertions hold). If any assertion fails, the pinned `@supabase/supabase-js` is too old — bump to the latest 2.x and re-run before proceeding.

- [ ] **Step 4: Commit**

```bash
git add oauth-consent/deno.json oauth-consent/deps_test.ts
git commit -m "[integrations] scaffold oauth-consent function + pin supabase-js with auth.oauth.*"
```

---

### Task 2: Pure decision/CSRF helpers

**Files:**
- Create: `oauth-consent/decision.ts`
- Test: `oauth-consent/decision_test.ts`

- [ ] **Step 1: Write the failing tests**

`oauth-consent/decision_test.ts`:

```ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  chooseEntryAction,
  csrfTokensMatch,
  generateCsrfToken,
  parseDecision,
} from "./decision.ts";

Deno.test("generateCsrfToken returns a long unguessable string", () => {
  const a = generateCsrfToken();
  const b = generateCsrfToken();
  assert(a.length >= 32);
  assert(a !== b);
});

Deno.test("csrfTokensMatch only matches identical non-empty tokens", () => {
  const t = generateCsrfToken();
  assert(csrfTokensMatch(t, t));
  assert(!csrfTokensMatch(t, t + "x"));
  assert(!csrfTokensMatch(undefined, t));
  assert(!csrfTokensMatch(t, undefined));
  assert(!csrfTokensMatch("", ""));
});

Deno.test("parseDecision accepts only approve/deny", () => {
  assertEquals(parseDecision("approve"), "approve");
  assertEquals(parseDecision("deny"), "deny");
  assertEquals(parseDecision("APPROVE"), null);
  assertEquals(parseDecision(undefined), null);
  assertEquals(parseDecision("maybe"), null);
});

Deno.test("chooseEntryAction picks the first action by precedence", () => {
  assertEquals(chooseEntryAction({ hasCode: true, authenticated: false }), "exchange-code");
  assertEquals(chooseEntryAction({ hasCode: true, authenticated: true }), "exchange-code");
  assertEquals(chooseEntryAction({ hasCode: false, authenticated: true }), "show-consent");
  assertEquals(chooseEntryAction({ hasCode: false, authenticated: false }), "begin-signin");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd oauth-consent && deno test decision_test.ts`
Expected: FAIL ("Module not found ./decision.ts").

- [ ] **Step 3: Write the implementation**

`oauth-consent/decision.ts`:

```ts
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd oauth-consent && deno test decision_test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add oauth-consent/decision.ts oauth-consent/decision_test.ts
git commit -m "[integrations] oauth-consent: pure CSRF + decision helpers"
```

---

### Task 3: Pure HTML rendering

**Files:**
- Create: `oauth-consent/consent_page.ts`
- Test: `oauth-consent/consent_page_test.ts`

- [ ] **Step 1: Write the failing tests**

`oauth-consent/consent_page_test.ts`:

```ts
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { consentPage, errorPage, escapeHtml, signInPage } from "./consent_page.ts";

Deno.test("escapeHtml neutralizes HTML metacharacters", () => {
  assertEquals(escapeHtml(`<script>"&'`), "&lt;script&gt;&quot;&amp;&#39;");
});

Deno.test("signInPage links to the provider URL and escapes the client name", () => {
  const html = signInPage("https://gh/auth?x=1&y=2", "<b>Evil</b>");
  assertStringIncludes(html, "https://gh/auth?x=1&amp;y=2");
  assertStringIncludes(html, "&lt;b&gt;Evil&lt;/b&gt;");
  assert(!html.includes("<b>Evil</b>"));
});

Deno.test("consentPage embeds authorization_id, csrf token, scopes, and both buttons", () => {
  const html = consentPage({
    clientName: "Claude",
    scopes: ["openid", "profile"],
    authorizationId: "auth-123",
    csrfToken: "tok-abc",
  });
  assertStringIncludes(html, 'name="authorization_id" value="auth-123"');
  assertStringIncludes(html, 'name="csrf" value="tok-abc"');
  assertStringIncludes(html, "openid");
  assertStringIncludes(html, "profile");
  assertStringIncludes(html, 'value="approve"');
  assertStringIncludes(html, 'value="deny"');
  assertStringIncludes(html, 'action="/functions/v1/oauth-consent/decision"');
});

Deno.test("errorPage shows the message and optional retry link", () => {
  assertStringIncludes(errorPage("boom"), "boom");
  assertStringIncludes(errorPage("boom", { retryUrl: "/retry" }), 'href="/retry"');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd oauth-consent && deno test consent_page_test.ts`
Expected: FAIL ("Module not found ./consent_page.ts").

- [ ] **Step 3: Write the implementation**

`oauth-consent/consent_page.ts`:

```ts
const DECISION_ACTION = "/functions/v1/oauth-consent/decision";

export function escapeHtml(s: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return s.replace(/[&<>"']/g, (c) => map[c]);
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 28rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.5; }
  .btn { display: inline-block; padding: .6rem 1rem; border-radius: .5rem; background: #111; color: #fff; text-decoration: none; border: 0; cursor: pointer; font-size: 1rem; }
  .btn.secondary { background: #fff; color: #111; border: 1px solid #ccc; }
  form { display: flex; gap: .75rem; margin-top: 1.5rem; }
  ul { background: #f5f5f5; border-radius: .5rem; padding: 1rem 1rem 1rem 2rem; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

export function signInPage(providerUrl: string, clientName: string): string {
  return layout("Authorize", `
<h1>Authorize ${escapeHtml(clientName)}</h1>
<p>Sign in with GitHub to review and approve this request.</p>
<a class="btn" href="${escapeHtml(providerUrl)}">Continue with GitHub</a>
`);
}

export function consentPage(opts: {
  clientName: string;
  scopes: string[];
  authorizationId: string;
  csrfToken: string;
}): string {
  const scopeItems = opts.scopes.length
    ? opts.scopes.map((s) => `<li>${escapeHtml(s)}</li>`).join("")
    : "<li>(no scopes requested)</li>";
  return layout("Authorize", `
<h1>${escapeHtml(opts.clientName)} wants access</h1>
<p>It is requesting these permissions on your Open Brain:</p>
<ul>${scopeItems}</ul>
<form method="POST" action="${DECISION_ACTION}">
  <input type="hidden" name="authorization_id" value="${escapeHtml(opts.authorizationId)}">
  <input type="hidden" name="csrf" value="${escapeHtml(opts.csrfToken)}">
  <button class="btn" type="submit" name="decision" value="approve">Approve</button>
  <button class="btn secondary" type="submit" name="decision" value="deny">Deny</button>
</form>
`);
}

export function errorPage(message: string, opts?: { retryUrl?: string }): string {
  const retry = opts?.retryUrl ? `<p><a href="${escapeHtml(opts.retryUrl)}">Try again</a></p>` : "";
  return layout("Error", `
<h1>Something went wrong</h1>
<p>${escapeHtml(message)}</p>
${retry}
`);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd oauth-consent && deno test consent_page_test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add oauth-consent/consent_page.ts oauth-consent/consent_page_test.ts
git commit -m "[integrations] oauth-consent: pure HTML rendering with escaping"
```

---

### Task 4: Hono app — server client, GET entry route, POST decision route

**Files:**
- Create: `oauth-consent/index.ts`
- Test: `oauth-consent/index_test.ts`

- [ ] **Step 1: Write the failing routing test (no Supabase needed)**

`oauth-consent/index_test.ts`:

```ts
import { assertEquals } from "jsr:@std/assert@1";
import { app } from "./index.ts";

Deno.test("GET entry without authorization_id returns 400", async () => {
  const res = await app.fetch(new Request("https://x/functions/v1/oauth-consent"));
  assertEquals(res.status, 400);
});

Deno.test("POST decision with missing fields returns 400 before any Supabase call", async () => {
  const res = await app.fetch(
    new Request("https://x/functions/v1/oauth-consent/decision", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "decision=approve", // no authorization_id
    }),
  );
  assertEquals(res.status, 400);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd oauth-consent && deno test index_test.ts --allow-net --allow-env --allow-read`
Expected: FAIL ("Module not found ./index.ts").

- [ ] **Step 3: Write the implementation**

`oauth-consent/index.ts`:

```ts
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd oauth-consent && deno test index_test.ts --allow-net --allow-env --allow-read`
Expected: PASS (2 tests). The 400 paths return before `makeClient`, so no env/network is required.

- [ ] **Step 5: Type-check the whole function**

Run: `cd oauth-consent && deno check index.ts`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add oauth-consent/index.ts oauth-consent/index_test.ts
git commit -m "[integrations] oauth-consent: Hono app, GitHub PKCE login, consent decision routes"
```

---

### Task 5: README + metadata.json

**Files:**
- Create: `oauth-consent/README.md`
- Create: `oauth-consent/metadata.json`

- [ ] **Step 1: Write `oauth-consent/README.md`**

````markdown
# OAuth Consent Edge Function

The authorization-server-side **consent page** for Open Brain's OAuth 2.1 setup.
Supabase Auth redirects users here (`Site URL + Authorization Path`) with an
`?authorization_id=...`; this function logs them in via GitHub and records their
approve/deny decision.

## Flow

1. `GET /functions/v1/oauth-consent?authorization_id=…` — if not signed in, starts
   GitHub OAuth (PKCE) via `@supabase/ssr` and shows a "Continue with GitHub" page.
2. GitHub returns to the same route with `?code=…`; the function exchanges it for a
   session, then calls `auth.oauth.getAuthorizationDetails` and renders the consent
   screen (client name + requested scopes, Approve / Deny).
3. `POST /functions/v1/oauth-consent/decision` — verifies a double-submit CSRF token,
   calls `approveAuthorization` / `denyAuthorization` (`skipBrowserRedirect: true`),
   and 302-redirects back to the OAuth client.

Any authenticated user may consent; per-user RLS (`user_id = auth.uid()`, see
`schemas/oauth-rls/`) isolates each tenant's brain, so a new sign-up gets an empty
brain rather than access to anyone else's.

## Deploy

Symlinked into the Supabase functions tree and deployed with `verify_jwt = false`:

```bash
ln -s ../../oauth-consent supabase/functions/oauth-consent
supabase functions deploy oauth-consent
```

## Required configuration

- Env/secrets: `SUPABASE_URL`, `SUPABASE_ANON_KEY`.
- Dashboard: **Site URL** = your project URL; **Authorization Path** =
  `/functions/v1/oauth-consent`.
- Enable the **GitHub** auth provider.
- Add `<project-url>/functions/v1/oauth-consent` to the redirect allow-list
  (`additional_redirect_urls`).

## Test

```bash
cd oauth-consent && deno test --allow-net --allow-env --allow-read
```
````

- [ ] **Step 2: Write `oauth-consent/metadata.json`**

```json
{
  "name": "OAuth Consent Edge Function",
  "description": "Authorization-server-side consent page for Open Brain's OAuth 2.1 setup. Signs the user in with GitHub via PKCE (@supabase/ssr), then drives the Supabase OAuth-server consent API (getAuthorizationDetails / approveAuthorization / denyAuthorization) to record approve/deny. Per-user RLS isolates each tenant.",
  "category": "integrations",
  "author": {
    "name": "David A. Ventimiglia",
    "github": "david-a-ventimiglia"
  },
  "version": "1.0.0",
  "requires": {
    "open_brain": true,
    "services": ["Supabase"],
    "tools": ["Supabase CLI", "Deno"]
  },
  "tags": ["oauth", "consent", "authentication", "edge-function", "github", "pkce"],
  "difficulty": "advanced",
  "estimated_time": "30 minutes",
  "created": "2026-06-16",
  "updated": "2026-06-16"
}
```

- [ ] **Step 3: Validate metadata against the repo schema**

Run: `python3 -c "import json; json.load(open('oauth-consent/metadata.json'))"`
Expected: no output (valid JSON). Cross-check required keys against `.github/metadata.schema.json`.

- [ ] **Step 4: Commit**

```bash
git add oauth-consent/README.md oauth-consent/metadata.json
git commit -m "[integrations] oauth-consent: README + metadata.json"
```

---

### Task 6: Deploy seam (symlink + function config)

**Files:**
- Create (gitignored): `supabase/functions/oauth-consent` (symlink)
- Modify (gitignored): `supabase/config.toml`

> These live under the gitignored `supabase/` deployment tree — they are NOT committed. This task wires local deploy only.

- [ ] **Step 1: Create the directory symlink (mirrors `open-brain-mcp` → `server`)**

Run:
```bash
cd /home/david-a-ventimiglia/Work/OB1
ln -s ../../oauth-consent supabase/functions/oauth-consent
ls -l supabase/functions/oauth-consent
```
Expected: symlink resolves to `../../oauth-consent`.

- [ ] **Step 2: Set `verify_jwt = false` for the function**

Add to `supabase/config.toml`:

```toml
[functions.oauth-consent]
verify_jwt = false
```

- [ ] **Step 3: Type-check via the deploy path**

Run: `deno check supabase/functions/oauth-consent/index.ts`
Expected: no errors (confirms the symlink + import map resolve).

- [ ] **Step 4: No commit** (gitignored tree). Note completion in the task tracker.

---

### Task 7: Deploy + manual end-to-end verification

**Files:** none (deployment + verification).

- [ ] **Step 1: Confirm the two NEW manual prerequisites are done**

These are operator steps (cannot be automated here):
- GitHub auth provider enabled in Supabase (GitHub OAuth app registered, client id/secret set).
- `<project-url>/functions/v1/oauth-consent` added to `additional_redirect_urls`.
- Dashboard **Site URL** set to the project URL and **Authorization Path** = `/functions/v1/oauth-consent`.

If any are missing, stop and surface them to the user — do not deploy a flow that will dead-end.

- [ ] **Step 2: Deploy the function**

Run: `supabase functions deploy oauth-consent`
Expected: deploy succeeds; `supabase functions list` shows `oauth-consent` ACTIVE with `verify_jwt: false`.

- [ ] **Step 3: Smoke-test the unauthenticated entry**

Run: `curl -si "https://<project-url>/functions/v1/oauth-consent?authorization_id=test" | head -20`
Expected: `200` HTML containing "Continue with GitHub" (the sign-in landing). `getAuthorizationDetails` is not reached pre-auth, so a dummy id is fine here.

- [ ] **Step 4: Full claude.ai connect flow (manual, the real integration test)**

In claude.ai → Settings → Connectors → add the `open-brain-mcp` function URL → authorize. Expected: redirected to the consent function → "Continue with GitHub" → GitHub login → consent screen showing the client name + scopes → Approve → redirected back to Claude → connector connected. Then confirm `capture_thought` / `search_thoughts` work and that captured rows carry `user_id = auth.uid()` (check `auth.uid()` resolved by confirming rows are visible to that user and scoped per tenant).

- [ ] **Step 5: Run the full test suite once more**

Run: `cd oauth-consent && deno test --allow-net --allow-env --allow-read`
Expected: all tests across `deps_test.ts`, `decision_test.ts`, `consent_page_test.ts`, `index_test.ts` PASS.

- [ ] **Step 6: Update PR + docs**

- Add `oauth-consent` to the PR description's summary of changes.
- Add the two new manual prerequisites (GitHub provider, redirect allow-list entry) to `docs/auth.md`'s prerequisites list.
- Commit the doc update:

```bash
git add docs/auth.md
git commit -m "[docs] document oauth-consent function + its manual prerequisites"
```

---

## Self-Review

**Spec coverage:**
- Hosting / `verify_jwt=false` → Tasks 4, 6. ✓
- GitHub-only social login → Task 4 (`signInWithOAuth({provider:'github'})`). ✓
- Any-authenticated-user consent (no allow-list) → Task 4 (no allow-list check). ✓
- `@supabase/ssr` PKCE cookie session → Tasks 1, 4. ✓
- Hono framework → Task 4. ✓
- Double-submit CSRF → Tasks 2 (helpers), 4 (set/verify). ✓
- Placement top-level `oauth-consent/` + README + metadata → Tasks 1–5. ✓
- Single entry route + decision route → Task 4. ✓
- `getAuthorizationDetails` two-shape handling (consent vs already-consented redirect) → Task 4. ✓
- `skipBrowserRedirect: true` on approve/deny (server context) → Task 4. ✓
- Error handling table → Task 4 (400 missing id, 400 expired details / exchange fail, 403 CSRF, 502 upstream, 302 re-auth). ✓
- Env (`SUPABASE_URL`, `SUPABASE_ANON_KEY`) → Task 4 `makeClient`. ✓
- Deploy seam (symlink, config.toml) → Task 6. ✓
- Two new manual prerequisites → Tasks 5, 7. ✓
- Resolution items (supabase-js version, ssr-on-Deno, auth.uid(), multi-segment path) → Task 1 (version+ssr probe), Task 7 step 4 (auth.uid(), path). ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; commands have expected output. ✓

**Type consistency:** `generateCsrfToken`/`csrfTokensMatch`/`parseDecision`/`chooseEntryAction` signatures match between `decision.ts` and its tests and `index.ts`. `escapeHtml`/`signInPage`/`consentPage`/`errorPage` match between `consent_page.ts`, its tests, and `index.ts`. `app` exported from `index.ts` and imported in `index_test.ts`. Consent API calls match the auth-js 2.108.2 signatures (`getAuthorizationDetails(id)`, `approve/denyAuthorization(id, {skipBrowserRedirect})`, response `{data,error}` with `data.redirect_url` / `'authorization_id' in data`). ✓

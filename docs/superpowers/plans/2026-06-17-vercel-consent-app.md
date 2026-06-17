# Vercel Consent App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-platform the OAuth 2.1 consent page from the blocked Supabase Edge Function to a Next.js 16 App Router app on Vercel, where HTML renders freely.

**Architecture:** A Next.js App Router app at top-level `oauth-consent/` (replacing the Deno code), deployed to Vercel. Supabase stays the OAuth authorization server, GitHub IdP, JWKS issuer, and RLS data backend. Auth/session uses `@supabase/ssr` (server client + `middleware.ts` refresh). GitHub login via PKCE; consent via `auth.oauth.getAuthorizationDetails`/`approveAuthorization`/`denyAuthorization`. CSRF is handled by Next Server Actions' built-in Origin check.

**Tech Stack:** Next.js 16.2.4, React 19.2.4, `@supabase/ssr@0.12.0`, `@supabase/supabase-js@2.108.2`, Vitest (unit tests), Vercel CLI (deploy).

**Spec:** `docs/superpowers/specs/2026-06-17-vercel-consent-app-design.md`

---

## File Structure

All under top-level `oauth-consent/` (Deno files there are removed in Task 1):

- `package.json`, `next.config.ts`, `tsconfig.json`, `.gitignore`, `vitest.config.ts` — project config.
- `middleware.ts` — session refresh (delegates to lib helper).
- `lib/supabase/server.ts` — per-request server Supabase client (cookies-backed).
- `lib/supabase/middleware.ts` — `updateSession(request)` used by `middleware.ts`.
- `lib/oauth.ts` — **pure** helpers (`parseScopes`, `parseDecision`, `isConsentDetails`); the only unit-tested unit.
- `lib/oauth.test.ts` — Vitest unit tests for `lib/oauth.ts`.
- `app/layout.tsx` — root layout.
- `app/oauth/consent/page.tsx` — entry Server Component (the single UI surface; renders error states + consent form, or redirects).
- `app/oauth/consent/consent-form.tsx` — Approve/Deny form bound to the Server Action.
- `app/actions.ts` — `decideAction` Server Action (approve/deny + redirect).
- `app/auth/signin/route.ts` — kicks off GitHub OAuth.
- `app/auth/callback/route.ts` — exchanges the OAuth code for a session.
- `metadata.json`, `README.md`.

**Flow:** Supabase redirects to `<vercel-origin>/oauth/consent?authorization_id=…` → page checks session → (no session) `/auth/signin` → GitHub → `/auth/callback?code=…&authorization_id=…` → exchange → back to consent page → `getAuthorizationDetails` → consent form → `decideAction` → `redirect_url` back to Claude.

**Working directory:** repo root `/home/david-a-ventimiglia/Work/OB1`, branch `feat/oauth-resource-server`. Node/npm assumed available; Vercel CLI is installed and authenticated.

---

### Task 1: Remove the abandoned Supabase Deno consent code

**Files:**
- Delete: `oauth-consent/index.ts`, `oauth-consent/decision.ts`, `oauth-consent/consent_page.ts`, `oauth-consent/deno.json`, `oauth-consent/index_test.ts`, `oauth-consent/decision_test.ts`, `oauth-consent/consent_page_test.ts`, `oauth-consent/deps_test.ts`
- Keep: `oauth-consent/README.md`, `oauth-consent/metadata.json` (rewritten in Task 7)

- [ ] **Step 1: Remove the Deno source + test files (tracked in git)**

Run:
```bash
cd /home/david-a-ventimiglia/Work/OB1
git rm oauth-consent/index.ts oauth-consent/decision.ts oauth-consent/consent_page.ts \
  oauth-consent/deno.json oauth-consent/index_test.ts oauth-consent/decision_test.ts \
  oauth-consent/consent_page_test.ts oauth-consent/deps_test.ts
```
Expected: the 8 files are staged for deletion. `oauth-consent/README.md` and `oauth-consent/metadata.json` remain.

- [ ] **Step 2: Remove the gitignored local deploy artifacts (no commit — these are not tracked)**

Run:
```bash
rm -f oauth-consent/deno.lock
rm -rf supabase/functions/oauth-consent
```
Then edit `supabase/config.toml` and delete the entire `[functions.oauth-consent]` block (the 5 lines: the header, `enabled`, `verify_jwt`, `import_map`, `entrypoint`). Leave the `[functions.open-brain-mcp]` block intact.

Verify: `grep -c "functions.oauth-consent" supabase/config.toml` → `0`.

- [ ] **Step 3: Commit the tracked deletions**

```bash
git add -A oauth-consent/
git commit -m "[integrations] remove Deno consent function (re-platforming to Vercel)"
```

> NOTE (operator/controller, live infra — not done by an implementer subagent): the broken `oauth-consent` function is still deployed on Supabase. It will be deleted with `supabase functions delete oauth-consent` in Task 8, which requires explicit user authorization.

---

### Task 2: Scaffold the Next.js app

**Files:**
- Create: `oauth-consent/package.json`, `oauth-consent/next.config.ts`, `oauth-consent/tsconfig.json`, `oauth-consent/.gitignore`, `oauth-consent/app/layout.tsx`, `oauth-consent/app/page.tsx`

- [ ] **Step 1: Create `oauth-consent/package.json`**

```json
{
  "name": "oauth-consent",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "test": "vitest run"
  },
  "dependencies": {
    "next": "16.2.4",
    "react": "19.2.4",
    "react-dom": "19.2.4",
    "@supabase/ssr": "0.12.0",
    "@supabase/supabase-js": "2.108.2"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "@types/node": "^22.10.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `oauth-consent/next.config.ts`**

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {};

export default nextConfig;
```

- [ ] **Step 3: Create `oauth-consent/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "ES2022"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 4: Create `oauth-consent/.gitignore`**

```gitignore
node_modules/
.next/
.vercel/
*.tsbuildinfo
next-env.d.ts
.env*.local
```

- [ ] **Step 5: Create `oauth-consent/app/layout.tsx`**

```tsx
export const metadata = {
  title: "Open Brain — Authorize",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body
        style={{
          maxWidth: "28rem",
          margin: "4rem auto",
          padding: "0 1rem",
          fontFamily: "system-ui, sans-serif",
          lineHeight: 1.5,
        }}
      >
        {children}
      </body>
    </html>
  );
}
```

- [ ] **Step 6: Create a placeholder `oauth-consent/app/page.tsx`**

```tsx
export default function Home() {
  return <p>Open Brain OAuth consent service.</p>;
}
```

- [ ] **Step 7: Install and build**

Run:
```bash
cd /home/david-a-ventimiglia/Work/OB1/oauth-consent && npm install && npm run build
```
Expected: install succeeds; `next build` completes with no type errors (it compiles the layout + placeholder page).

- [ ] **Step 8: Commit**

```bash
cd /home/david-a-ventimiglia/Work/OB1
git add oauth-consent/package.json oauth-consent/package-lock.json oauth-consent/next.config.ts \
  oauth-consent/tsconfig.json oauth-consent/.gitignore oauth-consent/app/layout.tsx oauth-consent/app/page.tsx
git commit -m "[integrations] scaffold Next.js consent app"
```

---

### Task 3: Supabase SSR clients + middleware

**Files:**
- Create: `oauth-consent/lib/supabase/server.ts`, `oauth-consent/lib/supabase/middleware.ts`, `oauth-consent/middleware.ts`

- [ ] **Step 1: Create `oauth-consent/lib/supabase/server.ts`**

```ts
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// Per-request server client. Must be created per request (never shared).
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // setAll throws when called from a Server Component (cookies are
            // read-only there). Safe to ignore: middleware refreshes the session.
          }
        },
      },
    },
  );
}
```

- [ ] **Step 2: Create `oauth-consent/lib/supabase/middleware.ts`**

```ts
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // IMPORTANT: do not run code between createServerClient and getUser().
  // getUser() refreshes the auth token and writes refreshed cookies via setAll.
  await supabase.auth.getUser();

  return supabaseResponse;
}
```

- [ ] **Step 3: Create `oauth-consent/middleware.ts`**

```ts
import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function middleware(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
```

- [ ] **Step 4: Type-check**

Run: `cd /home/david-a-ventimiglia/Work/OB1/oauth-consent && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
cd /home/david-a-ventimiglia/Work/OB1
git add oauth-consent/lib/supabase/server.ts oauth-consent/lib/supabase/middleware.ts oauth-consent/middleware.ts
git commit -m "[integrations] consent app: @supabase/ssr server client + session middleware"
```

---

### Task 4: Pure OAuth helpers (TDD)

**Files:**
- Create: `oauth-consent/lib/oauth.ts`, `oauth-consent/lib/oauth.test.ts`, `oauth-consent/vitest.config.ts`

- [ ] **Step 1: Create `oauth-consent/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts"],
  },
});
```

- [ ] **Step 2: Write the failing tests `oauth-consent/lib/oauth.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { isConsentDetails, parseDecision, parseScopes } from "./oauth";

describe("parseScopes", () => {
  it("splits on whitespace and drops empties", () => {
    expect(parseScopes("openid profile email")).toEqual(["openid", "profile", "email"]);
    expect(parseScopes("  a   b ")).toEqual(["a", "b"]);
    expect(parseScopes("")).toEqual([]);
    expect(parseScopes(null)).toEqual([]);
    expect(parseScopes(undefined)).toEqual([]);
  });
});

describe("parseDecision", () => {
  it("accepts only approve/deny", () => {
    expect(parseDecision("approve")).toBe("approve");
    expect(parseDecision("deny")).toBe("deny");
    expect(parseDecision("APPROVE")).toBeNull();
    expect(parseDecision("maybe")).toBeNull();
    expect(parseDecision(undefined)).toBeNull();
    expect(parseDecision(null)).toBeNull();
  });
});

describe("isConsentDetails", () => {
  it("detects the consent-details shape vs the already-consented redirect shape", () => {
    expect(isConsentDetails({ authorization_id: "x", client: { name: "C" }, scope: "openid" })).toBe(true);
    expect(isConsentDetails({ redirect_url: "https://app/callback?code=1" })).toBe(false);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd /home/david-a-ventimiglia/Work/OB1/oauth-consent && npm run test`
Expected: FAIL ("Failed to resolve import './oauth'").

- [ ] **Step 4: Write `oauth-consent/lib/oauth.ts`**

```ts
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
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd /home/david-a-ventimiglia/Work/OB1/oauth-consent && npm run test`
Expected: PASS (3 test files' worth of assertions, all green).

- [ ] **Step 6: Commit**

```bash
cd /home/david-a-ventimiglia/Work/OB1
git add oauth-consent/lib/oauth.ts oauth-consent/lib/oauth.test.ts oauth-consent/vitest.config.ts
git commit -m "[integrations] consent app: pure OAuth helpers + tests"
```

---

### Task 5: Sign-in and callback route handlers

**Files:**
- Create: `oauth-consent/app/auth/signin/route.ts`, `oauth-consent/app/auth/callback/route.ts`

- [ ] **Step 1: Create `oauth-consent/app/auth/signin/route.ts`**

```ts
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Kicks off GitHub OAuth. Supabase writes the PKCE verifier cookie; we issue
// the redirect ourselves (skipBrowserRedirect: true, no browser window here).
export async function GET(request: NextRequest) {
  const authorizationId = request.nextUrl.searchParams.get("authorization_id");

  const supabase = await createClient();
  const callback = new URL("/auth/callback", request.url);
  if (authorizationId) {
    callback.searchParams.set("authorization_id", authorizationId);
  }

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "github",
    options: { redirectTo: callback.toString(), skipBrowserRedirect: true },
  });

  if (error || !data?.url) {
    return NextResponse.redirect(
      new URL("/oauth/consent?error=signin_failed", request.url),
    );
  }
  return NextResponse.redirect(data.url);
}
```

- [ ] **Step 2: Create `oauth-consent/app/auth/callback/route.ts`**

```ts
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

// GitHub -> Supabase returns here with ?code (and our preserved authorization_id).
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const authorizationId = request.nextUrl.searchParams.get("authorization_id");

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      return NextResponse.redirect(
        new URL("/oauth/consent?error=signin_failed", request.url),
      );
    }
  }

  const dest = new URL("/oauth/consent", request.url);
  if (authorizationId) {
    dest.searchParams.set("authorization_id", authorizationId);
  }
  return NextResponse.redirect(dest);
}
```

- [ ] **Step 3: Type-check**

Run: `cd /home/david-a-ventimiglia/Work/OB1/oauth-consent && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
cd /home/david-a-ventimiglia/Work/OB1
git add oauth-consent/app/auth/signin/route.ts oauth-consent/app/auth/callback/route.ts
git commit -m "[integrations] consent app: GitHub sign-in + code-exchange routes"
```

---

### Task 6: Consent page, form, and decision Server Action

**Files:**
- Create: `oauth-consent/app/actions.ts`, `oauth-consent/app/oauth/consent/consent-form.tsx`, `oauth-consent/app/oauth/consent/page.tsx`

- [ ] **Step 1: Create `oauth-consent/app/actions.ts`**

```ts
"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { parseDecision } from "@/lib/oauth";

// Records the user's approve/deny decision. CSRF is enforced by Next's built-in
// Server Action Origin check. redirect() throws, so control never falls through.
export async function decideAction(formData: FormData) {
  const authorizationId = String(formData.get("authorization_id") ?? "");
  const decision = parseDecision(formData.get("decision"));

  if (!authorizationId || !decision) {
    redirect("/oauth/consent?error=decision_failed");
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(
      `/oauth/consent?authorization_id=${encodeURIComponent(authorizationId)}`,
    );
  }

  const result =
    decision === "approve"
      ? await supabase.auth.oauth.approveAuthorization(authorizationId, {
          skipBrowserRedirect: true,
        })
      : await supabase.auth.oauth.denyAuthorization(authorizationId, {
          skipBrowserRedirect: true,
        });

  if (result.error || !result.data?.redirect_url) {
    redirect(
      `/oauth/consent?error=decision_failed&authorization_id=${encodeURIComponent(authorizationId)}`,
    );
  }

  redirect(result.data.redirect_url);
}
```

- [ ] **Step 2: Create `oauth-consent/app/oauth/consent/consent-form.tsx`**

```tsx
import { decideAction } from "@/app/actions";

// React escapes interpolated text by default, so clientName/scope are XSS-safe.
export function ConsentForm({
  authorizationId,
  clientName,
  scopes,
}: {
  authorizationId: string;
  clientName: string;
  scopes: string[];
}) {
  return (
    <>
      <h1>{clientName} wants access</h1>
      <p>It is requesting these permissions on your Open Brain:</p>
      <ul>
        {scopes.length > 0 ? (
          scopes.map((s) => <li key={s}>{s}</li>)
        ) : (
          <li>(no scopes requested)</li>
        )}
      </ul>
      <form style={{ display: "flex", gap: "0.75rem", marginTop: "1.5rem" }}>
        <input type="hidden" name="authorization_id" value={authorizationId} />
        <button type="submit" formAction={decideAction} name="decision" value="approve">
          Approve
        </button>
        <button type="submit" formAction={decideAction} name="decision" value="deny">
          Deny
        </button>
      </form>
    </>
  );
}
```

- [ ] **Step 3: Create `oauth-consent/app/oauth/consent/page.tsx`**

```tsx
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isConsentDetails, parseScopes } from "@/lib/oauth";
import { ConsentForm } from "./consent-form";

const ERROR_MESSAGES: Record<string, string> = {
  signin_failed: "Sign-in failed. Please try again.",
  decision_failed: "We could not record your decision. Please try again.",
};

export default async function ConsentPage({
  searchParams,
}: {
  searchParams: Promise<{ authorization_id?: string; error?: string }>;
}) {
  const { authorization_id: authorizationId, error } = await searchParams;

  if (error) {
    return <p>{ERROR_MESSAGES[error] ?? "Something went wrong."}</p>;
  }
  if (!authorizationId) {
    return <p>This consent link is missing its authorization id.</p>;
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(
      `/auth/signin?authorization_id=${encodeURIComponent(authorizationId)}`,
    );
  }

  const { data, error: detailsError } =
    await supabase.auth.oauth.getAuthorizationDetails(authorizationId);

  if (detailsError || !data) {
    return <p>This authorization request has expired or is invalid.</p>;
  }
  if (!isConsentDetails(data)) {
    redirect(data.redirect_url);
  }

  return (
    <ConsentForm
      authorizationId={authorizationId}
      clientName={data.client?.name ?? "this application"}
      scopes={parseScopes(data.scope)}
    />
  );
}
```

- [ ] **Step 4: Type-check and build**

Run: `cd /home/david-a-ventimiglia/Work/OB1/oauth-consent && npx tsc --noEmit && npm run build`
Expected: no type errors; `next build` succeeds (routes `/oauth/consent`, `/auth/signin`, `/auth/callback` compile). If `next build` complains that `data.client`/`data.scope`/`data.redirect_url` are not on the narrowed type, it means the `@supabase/supabase-js` union members differ from the structural guard — report the exact type error rather than casting blindly.

- [ ] **Step 5: Run unit tests once more (nothing should have broken)**

Run: `cd /home/david-a-ventimiglia/Work/OB1/oauth-consent && npm run test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /home/david-a-ventimiglia/Work/OB1
git add oauth-consent/app/actions.ts oauth-consent/app/oauth/consent/consent-form.tsx oauth-consent/app/oauth/consent/page.tsx
git commit -m "[integrations] consent app: consent page, form, and decision Server Action"
```

---

### Task 7: README + metadata.json

**Files:**
- Modify: `oauth-consent/README.md`, `oauth-consent/metadata.json`

- [ ] **Step 1: Overwrite `oauth-consent/README.md`**

````markdown
# OAuth Consent App (Vercel)

The authorization-server-side **consent page** for Open Brain's OAuth 2.1 setup,
hosted on **Vercel** (Next.js App Router). Supabase Auth redirects users here
(`Site URL + Authorization Path`) with an `?authorization_id=…`; this app logs
them in via GitHub and records their approve/deny decision.

> Why Vercel: Supabase rewrites HTML served from Edge Functions on the default
> `*.supabase.co` domain to `text/plain` with a `sandbox` CSP (real HTML needs a
> Pro custom domain), which breaks an interactive consent page. Vercel renders
> HTML on its default domain. Supabase remains the OAuth authorization server,
> GitHub identity provider, JWKS issuer, and RLS data backend.

## Flow

1. `GET /oauth/consent?authorization_id=…` — if not signed in, redirects to
   `/auth/signin`, which starts GitHub OAuth (PKCE) via `@supabase/ssr`.
2. GitHub returns to `/auth/callback?code=…`; the app exchanges it for a session,
   then returns to `/oauth/consent`, calls `auth.oauth.getAuthorizationDetails`,
   and renders the consent screen (client name + scopes, Approve / Deny).
3. Approve/Deny posts to a Next **Server Action** (built-in CSRF protection),
   which calls `approveAuthorization` / `denyAuthorization`
   (`skipBrowserRedirect: true`) and redirects back to the OAuth client.

Any authenticated user may consent; per-user RLS (`user_id = auth.uid()`, see
`schemas/oauth-rls/`) isolates each tenant's brain.

## Develop

```bash
npm install
npm run test     # unit tests for lib/oauth.ts
npm run dev      # local dev server
```

## Deploy (Vercel CLI)

```bash
vercel          # first run links/creates the project
vercel --prod   # production deploy; note the production URL
```

Set in the Vercel project env: `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`.

## Supabase configuration

- **Site URL** = the Vercel production origin.
- **Authorization Path** = `/oauth/consent`.
- Add `<vercel-origin>/auth/callback` to `additional_redirect_urls`.
- GitHub provider enabled; the GitHub OAuth app's callback stays
  `https://<project-ref>.supabase.co/auth/v1/callback`.
````

- [ ] **Step 2: Overwrite `oauth-consent/metadata.json`**

```json
{
  "name": "OAuth Consent App (Vercel)",
  "description": "Authorization-server-side consent page for Open Brain's OAuth 2.1 setup, hosted on Vercel (Next.js App Router). Signs the user in with GitHub via PKCE (@supabase/ssr), then drives the Supabase OAuth-server consent API (getAuthorizationDetails / approveAuthorization / denyAuthorization) to record approve/deny. Per-user RLS isolates each tenant.",
  "category": "integrations",
  "author": {
    "name": "David A. Ventimiglia",
    "github": "david-a-ventimiglia"
  },
  "version": "1.0.0",
  "requires": {
    "open_brain": true,
    "services": ["Supabase", "Vercel"],
    "tools": ["Vercel CLI", "Node.js"]
  },
  "tags": ["oauth", "consent", "authentication", "nextjs", "vercel", "github", "pkce"],
  "difficulty": "advanced",
  "estimated_time": "45 minutes",
  "created": "2026-06-16",
  "updated": "2026-06-17"
}
```

- [ ] **Step 3: Validate metadata**

Run: `cd /home/david-a-ventimiglia/Work/OB1 && python3 -c "import json; json.load(open('oauth-consent/metadata.json'))"`
Expected: no output (valid JSON). Cross-check required keys against `.github/metadata.schema.json`; if a required field is missing or a value violates the schema, report it rather than inventing values.

- [ ] **Step 4: Commit**

```bash
cd /home/david-a-ventimiglia/Work/OB1
git add oauth-consent/README.md oauth-consent/metadata.json
git commit -m "[integrations] consent app: README + metadata for the Vercel re-platform"
```

---

### Task 8: Deploy + cutover + e2e (operator / controller, live)

**Files:** none (deployment, dashboard, and live verification). These steps touch live infra and external accounts; they require explicit user authorization and cannot be done by an implementer subagent.

- [ ] **Step 1: Delete the obsolete Supabase function**

Run: `supabase functions delete oauth-consent`
Expected: the function is removed; `supabase functions list` no longer shows `oauth-consent`.

- [ ] **Step 2: Deploy to Vercel**

Run from `oauth-consent/`: `vercel` (link/create the project), then `vercel --prod`.
Expected: a production URL like `https://oauth-consent-<scope>.vercel.app`. Record it as `<vercel-origin>`.

- [ ] **Step 3: Set Vercel env vars**

In the Vercel project (dashboard or `vercel env add`): set `NEXT_PUBLIC_SUPABASE_URL` = `https://cznjlmqnxoaykcdzbjry.supabase.co` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` = the project anon/publishable key, for Production. Redeploy if they were added after the first deploy (`vercel --prod`).

- [ ] **Step 4: Wire Supabase to the Vercel origin**

In the Supabase dashboard:
- **Site URL** → `<vercel-origin>`
- **Authorization Path** → `/oauth/consent`
- **`additional_redirect_urls`** → add `<vercel-origin>/auth/callback`
- Confirm the GitHub provider is enabled and its OAuth app callback is `https://cznjlmqnxoaykcdzbjry.supabase.co/auth/v1/callback` (unchanged).

- [ ] **Step 5: Smoke-test the entry page**

Run: `curl -si "<vercel-origin>/oauth/consent?authorization_id=smoke" | head -20`
Expected: `200` with `content-type: text/html` (NOT `text/plain`, and no `sandbox` CSP). It will redirect to `/auth/signin` then GitHub; following in a browser should show GitHub's login.

- [ ] **Step 6: Full claude.ai connect flow**

Add the `open-brain-mcp` function URL as a connector on claude.ai → authorize → expect redirect to the Vercel consent app → GitHub login → consent screen (client name + scopes) → Approve → redirected back to Claude → connected. Then confirm `capture_thought` / `search_thoughts` work and rows are scoped to the authenticated user (`user_id = auth.uid()`). If the Approve Server Action is rejected with an Origin error, set `serverActions.allowedOrigins` in `next.config.ts` to include the Vercel domain and redeploy.

- [ ] **Step 7: Update `docs/auth.md`**

Replace the consent-page prerequisites (currently describing the Supabase Edge Function) with the Vercel model: deploy the `oauth-consent/` app to Vercel; set `NEXT_PUBLIC_SUPABASE_*` env; set Site URL/Authorization Path/`additional_redirect_urls` to the Vercel origin. Commit:
```bash
git add docs/auth.md
git commit -m "[docs] consent page now hosted on Vercel; update prerequisites"
```

- [ ] **Step 8: Update PR #1**

Add a comment summarizing the re-platform (why Supabase HTML hosting was abandoned, the Vercel Next.js app, the env/redirect changes).

---

## Self-Review

**Spec coverage:**
- Vercel host / default `*.vercel.app` → Tasks 2, 8. ✓
- Next.js 16 App Router + React 19 → Task 2. ✓
- `@supabase/ssr` server client + middleware session refresh → Task 3 (canonical async `cookies()` + `updateSession`). ✓
- GitHub-only login (PKCE, `skipBrowserRedirect`) → Task 5. ✓
- Any-authenticated-user consent, no allow-list → Task 6 (no allow-list check). ✓
- Server Action CSRF (no double-submit token) → Task 6. ✓
- Replace `oauth-consent/` in place → Tasks 1–2. ✓
- Single entry page + signin/callback routes + decision action → Tasks 5, 6. ✓
- `getAuthorizationDetails` dual-shape (`isConsentDetails`) + already-consented redirect → Tasks 4, 6. ✓
- Error handling table (missing id, signin_failed, expired, decision_failed, already-consented) → Tasks 5, 6. ✓
- Env (`NEXT_PUBLIC_SUPABASE_URL/ANON_KEY`) → Tasks 3, 8. ✓
- Cleanup (delete Deno code, config block, copy; `supabase functions delete`; keep deploy script) → Tasks 1, 8. ✓
- Supabase wiring (Site URL, Authorization Path, redirect allow-list; GitHub callback unchanged) → Task 8. ✓
- Testing (pure helpers via Vitest; manual e2e) → Tasks 4, 8. ✓
- Verify items (ssr cookies adapter shape; Server Action allowedOrigins; auth.uid()) → Tasks 3, 6, 8. ✓

**Placeholder scan:** No TBD/TODO; every code step has complete code; commands have expected output. The `<vercel-origin>` token in Task 8 is a runtime value (the production URL isn't known until deploy), explicitly recorded in Step 2 — not a placeholder for missing content.

**Type consistency:** `parseScopes`/`parseDecision`/`isConsentDetails` signatures match between `lib/oauth.ts`, `lib/oauth.test.ts`, `app/actions.ts`, and `app/oauth/consent/page.tsx`. `createClient()` (async) is imported consistently in `server.ts`, the two route handlers, the page, and the action. `ConsentForm` props (`authorizationId`, `clientName`, `scopes`) match between `consent-form.tsx` and `page.tsx`. `decideAction(formData: FormData)` matches between `actions.ts` and the form's `formAction`. Consent API calls match auth-js 2.108.2 (`getAuthorizationDetails(id)`, `approve/denyAuthorization(id, {skipBrowserRedirect})`, `{data,error}` with `data.redirect_url`).

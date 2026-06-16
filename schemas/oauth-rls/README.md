# OAuth Per-User (Tenant) RLS Scoping

Turns the `thoughts` table into a proper **OAuth 2.1 resource server** backend by
scoping every row to the **authenticated user (tenant)** who created it.

## What it adds and why

Supabase OAuth access tokens are JWTs carrying `role: "authenticated"`, a `sub`
claim (the authenticated user's id) and a `client_id` claim (the OAuth app). A
per-request Supabase client created with the **anon key plus the caller's JWT**
runs as the `authenticated` role. To make Open Brain multi-tenant-safe, data is
partitioned by **user** so one tenant can never read or write another tenant's
memory. A user's brain follows the human across **any** OAuth client (Claude,
ChatGPT, …) because the partition key is the person, not the app — `client_id` is
kept only as provenance.

This migration:

1. **`user_id` tenant column + index** on `thoughts` (`uuid`, defaulting to
   `auth.uid()`, foreign key to `auth.users(id) ON DELETE CASCADE`).
   Deduplication is now **per-user**: any prior global / per-client unique index
   on `content_fingerprint` is dropped and replaced with a composite unique index
   on `(user_id, content_fingerprint)`, so two different tenants may independently
   store identical content without colliding. `client_id` is retained as a
   **non-scoping provenance column** (which app wrote the row); its standalone
   index is dropped.
2. **Four RLS policies for the `authenticated` role** — SELECT, INSERT, UPDATE,
   DELETE — each keyed on `user_id = auth.uid()`. The pre-existing
   `"Service role full access"` policy is left **intact**, so the service role
   keeps unrestricted access for admin and backfill tasks.
3. **GRANTs to `authenticated`** — `SELECT, INSERT, UPDATE, DELETE` on
   `public.thoughts`, plus `EXECUTE` on `match_thoughts(...)` and
   `upsert_thought(...)`. RLS policies do **not** grant access on their own; the
   role also needs these table- and function-level privileges.
4. **`upsert_thought` redefined as `SECURITY INVOKER`** — it now stamps `user_id`
   from `auth.uid()` (tenancy) and `client_id` from `auth.jwt() ->> 'client_id'`
   (provenance) on every inserted row, so the INSERT satisfies the INSERT policy.
   The dedup `ON CONFLICT` target is `(user_id, content_fingerprint)` to match the
   per-user composite unique index; the merge logic is otherwise unchanged.
5. **`match_thoughts` redefined as `SECURITY INVOKER`** — its internal `SELECT`
   now runs as the calling user and is therefore RLS-filtered to that tenant.

> **Warning — `enhanced-thoughts` users, do not apply verbatim.** This
> migration's `CREATE OR REPLACE FUNCTION upsert_thought` uses the **base**
> function body. If you installed the `enhanced-thoughts` schema (which ships a
> richer `upsert_thought` that writes extra columns such as `type`,
> `importance`, and `quality_score`), applying this migration as-is will
> **overwrite** that richer function with the base body and silently drop those
> extra writes. Instead, merge the changes this migration makes to
> `upsert_thought` — `user_id` stamping from `auth.uid()`, `client_id` stamping
> from `auth.jwt() ->> 'client_id'`, `SECURITY INVOKER`, and the per-user
> `ON CONFLICT (user_id, content_fingerprint)` target — into your own enhanced
> `upsert_thought` definition rather than running this one.

## How to apply

With the Supabase CLI (recommended):

```bash
supabase db push
```

Or paste the contents of `migration.sql` into the Supabase **SQL Editor** and run
it. The migration is idempotent where it matters (`IF NOT EXISTS` on the columns
and indexes; `CREATE OR REPLACE` on functions; `DROP POLICY IF EXISTS` before each
`CREATE POLICY`), so it can be re-run safely.

## Dependency: the JWT must carry a `sub` claim (and `auth.uid()` must resolve)

This schema assumes incoming access tokens are Supabase OAuth JWTs whose `sub`
claim is the authenticated user's id, so that `auth.uid()` resolves to that user.
Scoping is done entirely via `user_id = auth.uid()`. If your tokens do not carry a
usable `sub`, the policies evaluate `user_id = NULL` (never true in SQL) and the
client will see no rows — confirm your OAuth issuer populates `sub` before relying
on the scoping.

## Warning: use the caller JWT, not the service-role key

The per-request Supabase client **must** be constructed with the **anon key and
the caller's OAuth JWT** so it runs as the `authenticated` role. If you connect
with the **service-role key**, the `"Service role full access"` policy applies and
RLS is effectively bypassed — every tenant would see every row. Reserve the
service-role key for trusted server-side admin/backfill work only.

## Legacy NULL rows

Rows created **before** this migration have `user_id IS NULL`. Because the
authenticated-role policies require `user_id = auth.uid()`, those legacy rows are
**invisible to OAuth clients** until they are backfilled. They remain fully
visible to the service role.

To assign existing rows to a specific tenant, backfill with the service-role key
(which bypasses RLS):

```sql
-- Run as the service_role (e.g. in the SQL Editor).
-- Find your auth user id under Authentication > Users in the dashboard,
-- or via: select id, email from auth.users;
UPDATE thoughts
SET user_id = '00000000-0000-0000-0000-000000000000'  -- your auth.users.id
WHERE user_id IS NULL;
```

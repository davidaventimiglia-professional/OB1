# OAuth Per-Client RLS Scoping

Turns the `thoughts` table into a proper **OAuth 2.1 resource server** backend by
scoping every row to the OAuth client that created it.

## What it adds and why

Supabase OAuth access tokens are JWTs carrying `role: "authenticated"` and a
`client_id` claim. A per-request Supabase client created with the **anon key plus
the caller's JWT** runs as the `authenticated` role. To make Open Brain
multi-client-safe, data must be partitioned by `client_id` so one OAuth client
can never read or write another client's memory.

This migration:

1. **`client_id` column + index** on `thoughts` (`text`, indexed for fast scoping).
   Deduplication is now **per-client**: the previous global unique index on
   `content_fingerprint` is dropped and replaced with a composite unique index on
   `(client_id, content_fingerprint)`, so two different OAuth clients may
   independently store identical content without colliding.
2. **Four RLS policies for the `authenticated` role** — SELECT, INSERT, UPDATE,
   DELETE — each keyed on `client_id = (auth.jwt() ->> 'client_id')`. The
   pre-existing `"Service role full access"` policy is left **intact**, so the
   service role keeps unrestricted access for admin and backfill tasks.
3. **GRANTs to `authenticated`** — `SELECT, INSERT, UPDATE, DELETE` on
   `public.thoughts`, plus `EXECUTE` on `match_thoughts(...)` and
   `upsert_thought(...)`. RLS policies do **not** grant access on their own; the
   role also needs these table- and function-level privileges.
4. **`upsert_thought` redefined as `SECURITY INVOKER`** — it now reads
   `client_id` from the JWT (`auth.jwt() ->> 'client_id'`) and stamps it on every
   inserted row, so the INSERT satisfies the INSERT policy. The dedup
   `ON CONFLICT` target is `(client_id, content_fingerprint)` to match the
   per-client composite unique index; the merge logic is otherwise unchanged.
5. **`match_thoughts` redefined as `SECURITY INVOKER`** — its internal `SELECT`
   now runs as the calling client and is therefore RLS-filtered to that client's
   `client_id`.

> **Warning — `enhanced-thoughts` users, do not apply verbatim.** This
> migration's `CREATE OR REPLACE FUNCTION upsert_thought` uses the **base**
> function body. If you installed the `enhanced-thoughts` schema (which ships a
> richer `upsert_thought` that writes extra columns such as `type`,
> `importance`, and `quality_score`), applying this migration as-is will
> **overwrite** that richer function with the base body and silently drop those
> extra writes. Instead, merge the changes this migration makes to
> `upsert_thought` — `client_id` stamping from `auth.jwt() ->> 'client_id'`,
> `SECURITY INVOKER`, and the per-client `ON CONFLICT (client_id,
> content_fingerprint)` target — into your own enhanced `upsert_thought`
> definition rather than running this one.

## How to apply

With the Supabase CLI (recommended):

```bash
supabase db push
```

Or paste the contents of `migration.sql` into the Supabase **SQL Editor** and run
it. The migration is idempotent where it matters (`IF NOT EXISTS` on the column
and index; `CREATE OR REPLACE` on functions; `DROP POLICY IF EXISTS` before each
`CREATE POLICY`), so it can be re-run safely.

## Dependency: the JWT must carry a `client_id` claim

This schema assumes incoming access tokens are Supabase OAuth JWTs that include a
`client_id` claim. Scoping is done entirely via `(auth.jwt() ->> 'client_id')`.
If your tokens do not carry `client_id`, the policies will evaluate
`NULL = NULL` (which is not true in SQL) and the client will see no rows — confirm
your OAuth issuer populates this claim before relying on the scoping.

## Warning: use the caller JWT, not the service-role key

The per-request Supabase client **must** be constructed with the **anon key and
the caller's OAuth JWT** so it runs as the `authenticated` role. If you connect
with the **service-role key**, the `"Service role full access"` policy applies and
RLS is effectively bypassed — every client would see every row. Reserve the
service-role key for trusted server-side admin/backfill work only.

## Legacy NULL rows

Rows created **before** this migration have `client_id IS NULL`. Because the
authenticated-role policies require `client_id = (auth.jwt() ->> 'client_id')`,
those legacy rows are **invisible to OAuth clients** until they are backfilled.
They remain fully visible to the service role.

If you want to assign existing rows to a specific client, backfill with the
service-role key (which bypasses RLS):

```sql
-- Run as the service_role (e.g. in the SQL Editor).
UPDATE thoughts
SET client_id = 'your-oauth-client-id'
WHERE client_id IS NULL;
```

Choose a `client_id` value that matches the `client_id` claim the relevant OAuth
client will present in its JWT.

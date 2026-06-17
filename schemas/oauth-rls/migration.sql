-- -*- sql-product: postgres; -*-
--
-- oauth-rls: Per-user (tenant) RLS scoping for the `thoughts` table.
--
-- Purpose
--   Turns the `thoughts` table into a proper OAuth 2.1 resource server backend.
--   Supabase OAuth access tokens are JWTs with `role: "authenticated"`, a `sub`
--   claim (the authenticated user's id) and a `client_id` claim (the OAuth app).
--   A per-request Supabase client (anon key + the caller's JWT) runs as the
--   `authenticated` role, so all data is scoped PER USER (tenant) by
--   `user_id = auth.uid()`. A user's brain follows the human across any OAuth
--   client; `client_id` is retained only as provenance metadata.
--
--   This migration:
--     1. Adds a tenant column (`user_id uuid`, defaulting to `auth.uid()`, FK to
--        `auth.users`), indexes it, and makes content deduplication PER-USER
--        (composite unique index on `(user_id, content_fingerprint)`) so two
--        tenants may independently hold identical content. `client_id` is kept as
--        a non-scoping provenance column.
--     2. Adds four RLS policies for the `authenticated` role (SELECT/INSERT/
--        UPDATE/DELETE), each keyed on `user_id = auth.uid()`. The existing
--        "Service role full access" policy is left intact.
--     3. GRANTs table + function privileges to `authenticated` (RLS policies do
--        NOT grant access by themselves -- the role also needs GRANTs).
--     4. Redefines `upsert_thought` as SECURITY INVOKER and stamps `user_id` from
--        `auth.uid()` (tenancy) and `client_id` from the JWT (provenance) so its
--        INSERT satisfies the INSERT policy.
--     5. Redefines `match_thoughts` as SECURITY INVOKER so its internal SELECT is
--        RLS-filtered to the calling user.
--
-- LEGACY-NULL-ROWS CAVEAT
--   Any rows created before this migration have `user_id IS NULL`. Because the
--   authenticated-role policies require `user_id = auth.uid()`, those legacy rows
--   are INVISIBLE to OAuth clients until they are backfilled with a real user id.
--   They remain fully accessible to the service_role. See README.md for a
--   backfill example.

-- 1. Tenant column + provenance + indexes ------------------------------------

-- Tenancy key: the authenticated user. Defaults to auth.uid() so direct inserts
-- by the authenticated role are auto-stamped; FK to auth.users cascades deletes.
ALTER TABLE thoughts
  ADD COLUMN IF NOT EXISTS user_id uuid DEFAULT auth.uid()
  REFERENCES auth.users (id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_thoughts_user_id ON thoughts (user_id);

-- client_id is retained as non-scoping PROVENANCE (which OAuth app wrote the row).
-- It is no longer the tenancy key, so its standalone index is dropped.
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS client_id text;
DROP INDEX IF EXISTS idx_thoughts_client_id;

-- Deduplicate per tenant, not globally and not per client: a tenant dedups
-- against their own brain; another tenant's identical content is independent.
DROP INDEX IF EXISTS idx_thoughts_client_fingerprint;
DROP INDEX IF EXISTS idx_thoughts_fingerprint;
CREATE UNIQUE INDEX IF NOT EXISTS idx_thoughts_user_fingerprint
  ON thoughts (user_id, content_fingerprint)
  WHERE content_fingerprint IS NOT NULL;

-- 2. Per-user RLS policies for the authenticated role ------------------------
--    (RLS is already enabled by the lock-down migration. The existing
--     "Service role full access" policy is intentionally NOT dropped.)

DROP POLICY IF EXISTS "Authenticated client can select own thoughts" ON thoughts;
CREATE POLICY "Authenticated client can select own thoughts"
  ON thoughts
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Authenticated client can insert own thoughts" ON thoughts;
CREATE POLICY "Authenticated client can insert own thoughts"
  ON thoughts
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Authenticated client can update own thoughts" ON thoughts;
CREATE POLICY "Authenticated client can update own thoughts"
  ON thoughts
  FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Authenticated client can delete own thoughts" ON thoughts;
CREATE POLICY "Authenticated client can delete own thoughts"
  ON thoughts
  FOR DELETE
  TO authenticated
  USING (user_id = auth.uid());

-- 3. GRANTs for the authenticated role ---------------------------------------
--    RLS policies are necessary but not sufficient: the role still needs
--    table-level and function-level privileges.

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.thoughts TO authenticated;

GRANT EXECUTE ON FUNCTION match_thoughts(vector(1536), float, int, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION upsert_thought(text, jsonb) TO authenticated;

-- 4. upsert_thought: SECURITY INVOKER + stamp user_id / client_id ------------
--    Body is taken verbatim from the dedup migration; the only changes are the
--    explicit SECURITY INVOKER clause, the v_user_id / v_client_id declarations,
--    adding user_id (tenancy) and client_id (provenance) to the INSERT, and the
--    per-user ON CONFLICT target. The merge logic is otherwise unchanged.

CREATE OR REPLACE FUNCTION upsert_thought(p_content TEXT, p_payload JSONB DEFAULT '{}')
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_fingerprint TEXT;
  v_result JSONB;
  v_id UUID;
  v_user_id uuid := auth.uid();
  v_client_id text := (auth.jwt() ->> 'client_id');
BEGIN
  v_fingerprint := encode(sha256(convert_to(
    lower(trim(regexp_replace(p_content, '\s+', ' ', 'g'))),
    'UTF8'
  )), 'hex');

  INSERT INTO thoughts (content, content_fingerprint, metadata, user_id, client_id)
  VALUES (p_content, v_fingerprint, COALESCE(p_payload->'metadata', '{}'::jsonb), v_user_id, v_client_id)
  ON CONFLICT (user_id, content_fingerprint) WHERE content_fingerprint IS NOT NULL DO UPDATE
  SET updated_at = now(),
      metadata = thoughts.metadata || COALESCE(EXCLUDED.metadata, '{}'::jsonb)
  RETURNING id INTO v_id;

  v_result := jsonb_build_object('id', v_id, 'fingerprint', v_fingerprint);
  RETURN v_result;
END;
$$;

-- 5. match_thoughts: explicit SECURITY INVOKER -------------------------------
--    Body is copied verbatim from the semantic-search migration; the only
--    change is the explicit SECURITY INVOKER clause so the internal SELECT runs
--    as the calling user and is therefore RLS-filtered to that user_id.

create or replace function match_thoughts(
  query_embedding vector(1536),
  match_threshold float default 0.7,
  match_count int default 10,
  filter jsonb default '{}'::jsonb
)
returns table (
  id uuid,
  content text,
  metadata jsonb,
  similarity float,
  created_at timestamptz
)
language plpgsql
security invoker
as $$
begin
  return query
  select
    t.id,
    t.content,
    t.metadata,
    1 - (t.embedding <=> query_embedding) as similarity,
    t.created_at
  from thoughts t
  where 1 - (t.embedding <=> query_embedding) > match_threshold
    and (filter = '{}'::jsonb or t.metadata @> filter)
  order by t.embedding <=> query_embedding
  limit match_count;
end;
$$;

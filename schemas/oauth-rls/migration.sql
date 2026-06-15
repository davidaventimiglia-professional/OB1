-- -*- sql-product: postgres; -*-
--
-- oauth-rls: Per-client RLS scoping for the `thoughts` table.
--
-- Purpose
--   Turns the `thoughts` table into a proper OAuth 2.1 resource server backend.
--   Supabase OAuth access tokens are JWTs with `role: "authenticated"` and a
--   `client_id` claim. A per-request Supabase client (anon key + the caller's
--   JWT) runs as the `authenticated` role, so all data is scoped per client by
--   `client_id = (auth.jwt() ->> 'client_id')`.
--
--   This migration:
--     1. Adds an ownership column + index (`client_id`), and makes content
--        deduplication PER-CLIENT (composite unique index on
--        `(client_id, content_fingerprint)`) instead of global, so two clients
--        may independently hold identical content.
--     2. Adds four RLS policies for the `authenticated` role (SELECT/INSERT/
--        UPDATE/DELETE), each keyed on the JWT `client_id` claim. The existing
--        "Service role full access" policy is left intact.
--     3. GRANTs table + function privileges to `authenticated` (RLS policies do
--        NOT grant access by themselves -- the role also needs GRANTs).
--     4. Redefines `upsert_thought` as SECURITY INVOKER and stamps `client_id`
--        from the JWT so its INSERT satisfies the INSERT policy.
--     5. Redefines `match_thoughts` as SECURITY INVOKER so its internal SELECT
--        is RLS-filtered to the calling client.
--
-- LEGACY-NULL-ROWS CAVEAT
--   Any rows created before this migration have `client_id IS NULL`. Because the
--   authenticated-role policies require `client_id = (auth.jwt() ->> 'client_id')`,
--   those legacy rows are INVISIBLE to OAuth clients until they are backfilled
--   with a real client_id. They remain fully accessible to the service_role.
--   See README.md for a backfill example.

-- 1. Ownership column + index ------------------------------------------------

ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS client_id text;
CREATE INDEX IF NOT EXISTS idx_thoughts_client_id ON thoughts (client_id);

-- Deduplicate per client, not globally: two clients may hold identical content.
DROP INDEX IF EXISTS idx_thoughts_fingerprint;
CREATE UNIQUE INDEX IF NOT EXISTS idx_thoughts_client_fingerprint
  ON thoughts (client_id, content_fingerprint)
  WHERE content_fingerprint IS NOT NULL;

-- 2. Per-client RLS policies for the authenticated role ----------------------
--    (RLS is already enabled by the lock-down migration. The existing
--     "Service role full access" policy is intentionally NOT dropped.)

DROP POLICY IF EXISTS "Authenticated client can select own thoughts" ON thoughts;
CREATE POLICY "Authenticated client can select own thoughts"
  ON thoughts
  FOR SELECT
  TO authenticated
  USING (client_id = (auth.jwt() ->> 'client_id'));

DROP POLICY IF EXISTS "Authenticated client can insert own thoughts" ON thoughts;
CREATE POLICY "Authenticated client can insert own thoughts"
  ON thoughts
  FOR INSERT
  TO authenticated
  WITH CHECK (client_id = (auth.jwt() ->> 'client_id'));

DROP POLICY IF EXISTS "Authenticated client can update own thoughts" ON thoughts;
CREATE POLICY "Authenticated client can update own thoughts"
  ON thoughts
  FOR UPDATE
  TO authenticated
  USING (client_id = (auth.jwt() ->> 'client_id'))
  WITH CHECK (client_id = (auth.jwt() ->> 'client_id'));

DROP POLICY IF EXISTS "Authenticated client can delete own thoughts" ON thoughts;
CREATE POLICY "Authenticated client can delete own thoughts"
  ON thoughts
  FOR DELETE
  TO authenticated
  USING (client_id = (auth.jwt() ->> 'client_id'));

-- 3. GRANTs for the authenticated role ---------------------------------------
--    RLS policies are necessary but not sufficient: the role still needs
--    table-level and function-level privileges.

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.thoughts TO authenticated;

GRANT EXECUTE ON FUNCTION match_thoughts(vector(1536), float, int, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION upsert_thought(text, jsonb) TO authenticated;

-- 4. upsert_thought: SECURITY INVOKER + stamp client_id from JWT -------------
--    Body is taken verbatim from the dedup migration; the only changes are the
--    explicit SECURITY INVOKER clause, the v_client_id declaration, and adding
--    client_id to the INSERT column list / VALUES. The ON CONFLICT merge logic
--    is unchanged.

CREATE OR REPLACE FUNCTION upsert_thought(p_content TEXT, p_payload JSONB DEFAULT '{}')
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_fingerprint TEXT;
  v_result JSONB;
  v_id UUID;
  v_client_id text := (auth.jwt() ->> 'client_id');
BEGIN
  v_fingerprint := encode(sha256(convert_to(
    lower(trim(regexp_replace(p_content, '\s+', ' ', 'g'))),
    'UTF8'
  )), 'hex');

  INSERT INTO thoughts (content, content_fingerprint, metadata, client_id)
  VALUES (p_content, v_fingerprint, COALESCE(p_payload->'metadata', '{}'::jsonb), v_client_id)
  ON CONFLICT (client_id, content_fingerprint) WHERE content_fingerprint IS NOT NULL DO UPDATE
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
--    as the calling client and is therefore RLS-filtered to that client_id.

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

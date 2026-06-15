import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { exportJWK, generateKeyPair, type KeyLike, SignJWT } from "jose";
import {
  AuthError,
  buildProtectedResourceMetadata,
  createTokenValidator,
  protectedResourceMetadataUrl,
  resolveJwksUri,
  wwwAuthenticateChallenge,
} from "./auth.ts";

const RESOURCE =
  "https://cznjlmqnxoaykcdzbjry.supabase.co/functions/v1/open-brain-mcp";
const ISSUER = "https://cznjlmqnxoaykcdzbjry.supabase.co/auth/v1";
const METADATA_URL =
  "https://cznjlmqnxoaykcdzbjry.supabase.co/.well-known/oauth-authorization-server/auth/v1";
const CLIENT_ID = "11111111-1111-1111-1111-111111111111";

// --- Task B ---
Deno.test("buildProtectedResourceMetadata returns RFC 9728 fields", () => {
  const meta = buildProtectedResourceMetadata({
    resource: RESOURCE,
    issuer: ISSUER,
  });
  assertEquals(meta.resource, RESOURCE);
  assertEquals(meta.authorization_servers, [ISSUER]);
  assertEquals(meta.bearer_methods_supported, ["header"]);
  assertEquals(meta.scopes_supported, []);
});

// --- Task C ---
Deno.test("protectedResourceMetadataUrl appends well-known path", () => {
  assertEquals(
    protectedResourceMetadataUrl(RESOURCE),
    `${RESOURCE}/.well-known/oauth-protected-resource`,
  );
});

Deno.test("wwwAuthenticateChallenge returns exact Bearer challenge", () => {
  assertEquals(
    wwwAuthenticateChallenge(RESOURCE),
    `Bearer resource_metadata="${RESOURCE}/.well-known/oauth-protected-resource"`,
  );
});

// --- Task D ---
Deno.test("resolveJwksUri fetches once and caches by metadataUrl", async () => {
  const jwksUri = `${ISSUER}/.well-known/jwks.json`;
  let calls = 0;
  // Use a unique metadataUrl so this test is independent of cache state.
  const uniqueMetadataUrl = `${METADATA_URL}?t=${crypto.randomUUID()}`;
  const fetchImpl = ((_input: string | URL | Request) => {
    calls++;
    return Promise.resolve(
      new Response(JSON.stringify({ issuer: ISSUER, jwks_uri: jwksUri }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;

  const cfg = {
    issuer: ISSUER,
    metadataUrl: uniqueMetadataUrl,
    fetchImpl,
  };
  const a = await resolveJwksUri(cfg);
  const b = await resolveJwksUri(cfg);
  assertEquals(a, jwksUri);
  assertEquals(b, jwksUri);
  assertEquals(calls, 1);
});

Deno.test("resolveJwksUri throws on issuer mismatch", async () => {
  const fetchImpl = (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          issuer: "https://evil/auth/v1",
          jwks_uri: "https://evil/jwks",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )) as typeof fetch;
  await assertRejects(() =>
    resolveJwksUri({
      issuer: ISSUER,
      metadataUrl: `${METADATA_URL}?mismatch=${crypto.randomUUID()}`,
      fetchImpl,
    })
  );
});

Deno.test("resolveJwksUri throws when jwks_uri missing", async () => {
  const fetchImpl = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ issuer: ISSUER }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )) as typeof fetch;
  await assertRejects(() =>
    resolveJwksUri({
      issuer: ISSUER,
      metadataUrl: `${METADATA_URL}?nojwks=${crypto.randomUUID()}`,
      fetchImpl,
    })
  );
});

// --- Task E helpers ---
async function makeKeySet() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-kid";
  jwk.alg = "RS256";
  jwk.use = "sig";
  return { privateKey, keySet: { keys: [jwk] } };
}

async function signToken(
  privateKey: KeyLike,
  { issuer, clientId, exp }: {
    issuer: string;
    clientId: string;
    exp?: string;
  },
) {
  let builder = new SignJWT({ role: "authenticated", client_id: clientId })
    .setProtectedHeader({ alg: "RS256", kid: "test-kid" })
    .setIssuer(issuer)
    .setAudience("authenticated")
    .setIssuedAt();
  builder = builder.setExpirationTime(exp ?? "5m");
  return await builder.sign(privateKey);
}

// --- Task E tests ---
Deno.test("validate returns claims for a valid token", async () => {
  const { privateKey, keySet } = await makeKeySet();
  const validate = createTokenValidator({
    issuer: ISSUER,
    expectedClientId: CLIENT_ID,
    getKeySet: () => Promise.resolve(keySet),
  });
  const token = await signToken(privateKey, {
    issuer: ISSUER,
    clientId: CLIENT_ID,
  });
  const claims = await validate(`Bearer ${token}`);
  assertEquals(claims.client_id, CLIENT_ID);
  assertEquals(claims.iss, ISSUER);
});

Deno.test("validate rejects missing and non-Bearer headers", async () => {
  const { keySet } = await makeKeySet();
  const validate = createTokenValidator({
    issuer: ISSUER,
    expectedClientId: CLIENT_ID,
    getKeySet: () => Promise.resolve(keySet),
  });
  await assertRejects(() => validate(undefined), AuthError);
  await assertRejects(() => validate("Basic abc"), AuthError);
  await assertRejects(() => validate("Bearer "), AuthError);
});

Deno.test("validate rejects an expired token", async () => {
  const { privateKey, keySet } = await makeKeySet();
  const validate = createTokenValidator({
    issuer: ISSUER,
    expectedClientId: CLIENT_ID,
    getKeySet: () => Promise.resolve(keySet),
  });
  const token = await signToken(privateKey, {
    issuer: ISSUER,
    clientId: CLIENT_ID,
    exp: "-1m",
  });
  await assertRejects(() => validate(`Bearer ${token}`), AuthError);
});

Deno.test("validate rejects a token with the wrong issuer", async () => {
  const { privateKey, keySet } = await makeKeySet();
  const otherValidate = createTokenValidator({
    issuer: "https://other/auth/v1",
    expectedClientId: CLIENT_ID,
    getKeySet: () => Promise.resolve(keySet),
  });
  const token = await signToken(privateKey, {
    issuer: ISSUER,
    clientId: CLIENT_ID,
  });
  await assertRejects(() => otherValidate(`Bearer ${token}`), AuthError);
});

Deno.test("validate rejects a token with the wrong client_id", async () => {
  const { privateKey, keySet } = await makeKeySet();
  const validate = createTokenValidator({
    issuer: ISSUER,
    expectedClientId: CLIENT_ID,
    getKeySet: () => Promise.resolve(keySet),
  });
  const token = await signToken(privateKey, {
    issuer: ISSUER,
    clientId: "99999999-9999-9999-9999-999999999999",
  });
  await assertRejects(() => validate(`Bearer ${token}`), AuthError);
});

Deno.test("validate rejects a token missing client_id", async () => {
  const { privateKey, keySet } = await makeKeySet();
  const validate = createTokenValidator({
    issuer: ISSUER,
    expectedClientId: CLIENT_ID,
    getKeySet: () => Promise.resolve(keySet),
  });
  // Build the payload WITHOUT a client_id claim at all (not set to undefined).
  const token = await new SignJWT({ role: "authenticated" })
    .setProtectedHeader({ alg: "RS256", kid: "test-kid" })
    .setIssuer(ISSUER)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  await assertRejects(() => validate(`Bearer ${token}`), AuthError);
});

Deno.test("validate rejects a token with a bad signature", async () => {
  const { keySet } = await makeKeySet();
  // Sign with a different private key but the same advertised kid.
  const { privateKey: otherKey } = await generateKeyPair("RS256");
  const validate = createTokenValidator({
    issuer: ISSUER,
    expectedClientId: CLIENT_ID,
    getKeySet: () => Promise.resolve(keySet),
  });
  const token = await signToken(otherKey, {
    issuer: ISSUER,
    clientId: CLIENT_ID,
  });
  await assertRejects(() => validate(`Bearer ${token}`), AuthError);
});

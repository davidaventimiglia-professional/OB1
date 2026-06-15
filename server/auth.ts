/**
 * Self-contained OAuth 2.1 resource-server helpers for the open-brain MCP
 * Edge Function.
 *
 * This module is intentionally side-effect free on import (no `Deno.serve`,
 * no network calls at module load) so it can be unit tested in isolation.
 *
 * The server acts as an OAuth 2.1 *resource server*. The authorization server
 * (AS) is Supabase Auth. Access tokens are Supabase-issued JWTs that carry a
 * generic `aud: "authenticated"`, so audience binding to this resource is
 * enforced by matching the token's `client_id` claim against the single
 * registered OAuth client id rather than by checking `aud`.
 */

import {
  createLocalJWKSet,
  createRemoteJWKSet,
  type JWTPayload,
  jwtVerify,
} from "jose";

/** Error thrown for any authentication/authorization failure. */
export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

// --- Task B: RFC 9728 Protected Resource Metadata ---------------------------

export interface ProtectedResourceMetadataInput {
  /** The resource identifier (canonical URL of this MCP server). */
  resource: string;
  /** The authorization server issuer URL. */
  issuer: string;
}

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  bearer_methods_supported: string[];
  scopes_supported: string[];
}

/**
 * Build the OAuth 2.0 Protected Resource Metadata document (RFC 9728).
 */
export function buildProtectedResourceMetadata(
  input: ProtectedResourceMetadataInput,
): ProtectedResourceMetadata {
  return {
    resource: input.resource,
    authorization_servers: [input.issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: [],
  };
}

// --- Task C: well-known URL + WWW-Authenticate challenge --------------------

/**
 * The RFC 9728 well-known URL where this resource's metadata is served.
 */
export function protectedResourceMetadataUrl(resource: string): string {
  return `${resource}/.well-known/oauth-protected-resource`;
}

/**
 * The `WWW-Authenticate` header value to return on a 401, pointing clients at
 * the protected-resource metadata document.
 */
export function wwwAuthenticateChallenge(resource: string): string {
  return `Bearer resource_metadata="${protectedResourceMetadataUrl(resource)}"`;
}

// --- Task D: resolve jwks_uri from AS metadata (cached) ---------------------

export interface ResolveJwksUriConfig {
  /** Expected AS issuer; validated against the metadata `issuer` if present. */
  issuer: string;
  /** AS metadata document URL (RFC 8414). */
  metadataUrl: string;
  /** Override for `fetch` (test seam). */
  fetchImpl?: typeof fetch;
}

interface AuthorizationServerMetadata {
  issuer?: string;
  jwks_uri?: string;
}

/** Module-level cache of resolved jwks_uri values, keyed by metadataUrl. */
const jwksUriCache = new Map<string, string>();

/**
 * Fetch the AS metadata document and resolve its `jwks_uri`.
 *
 * The result is cached by `metadataUrl`, so repeat calls do not re-fetch.
 * The `jwks_uri` is always read from metadata and never hardcoded.
 */
export async function resolveJwksUri(
  cfg: ResolveJwksUriConfig,
): Promise<string> {
  const cached = jwksUriCache.get(cfg.metadataUrl);
  if (cached !== undefined) {
    return cached;
  }

  const doFetch = cfg.fetchImpl ?? fetch;
  const res = await doFetch(cfg.metadataUrl);
  if (!res.ok) {
    throw new AuthError(
      `Failed to fetch AS metadata: ${res.status} ${res.statusText}`,
    );
  }
  const meta = (await res.json()) as AuthorizationServerMetadata;

  if (meta.issuer !== undefined && meta.issuer !== cfg.issuer) {
    throw new AuthError(
      `AS metadata issuer mismatch: expected ${cfg.issuer}, got ${meta.issuer}`,
    );
  }
  if (!meta.jwks_uri) {
    throw new AuthError("AS metadata is missing jwks_uri");
  }

  jwksUriCache.set(cfg.metadataUrl, meta.jwks_uri);
  return meta.jwks_uri;
}

// --- Task E: token validator ------------------------------------------------

/** Claims expected on a verified Supabase access token. */
export interface Claims extends JWTPayload {
  client_id?: string;
  role?: string;
}

export interface TokenValidatorConfig {
  /** Expected token issuer (Supabase AS issuer). */
  issuer: string;
  /** The single registered OAuth client id this resource accepts. */
  expectedClientId: string;
  /**
   * Test seam: provide a JWKS object directly. When given, a local key set is
   * used instead of a remote one.
   */
  getKeySet?: () => Promise<{ keys: unknown[] }>;
  /** Remote JWKS URI; used when `getKeySet` is not provided. */
  jwksUri?: string;
}

type KeySetResolver = Awaited<ReturnType<typeof buildKeySet>>;

async function buildKeySet(cfg: TokenValidatorConfig) {
  if (cfg.getKeySet) {
    const jwks = await cfg.getKeySet();
    // deno-lint-ignore no-explicit-any
    return createLocalJWKSet(jwks as any);
  }
  if (cfg.jwksUri) {
    return createRemoteJWKSet(new URL(cfg.jwksUri));
  }
  throw new AuthError("Token validator requires either getKeySet or jwksUri");
}

/**
 * Build a `validate` function that verifies a Bearer token's signature,
 * issuer, and expiry against the AS key set, then enforces that the token's
 * `client_id` matches the single registered client id for this resource.
 *
 * On any failure it throws {@link AuthError}. On success it returns the
 * verified JWT claims.
 */
export function createTokenValidator(
  cfg: TokenValidatorConfig,
): (authorization: string | undefined) => Promise<Claims> {
  let keySetPromise: Promise<KeySetResolver> | undefined;
  const keySet = () => (keySetPromise ??= buildKeySet(cfg));

  return async function validate(
    authorization: string | undefined,
  ): Promise<Claims> {
    if (!authorization || !authorization.startsWith("Bearer ")) {
      throw new AuthError("Missing or malformed Authorization header");
    }
    const token = authorization.slice("Bearer ".length).trim();
    if (!token) {
      throw new AuthError("Empty bearer token");
    }

    let payload: Claims;
    try {
      const resolver = await keySet();
      const result = await jwtVerify(token, resolver, {
        issuer: cfg.issuer,
        algorithms: ["RS256", "ES256"], // Supabase asymmetric signing keys; never accept alg:none/HMAC
      });
      payload = result.payload as Claims;
    } catch (err) {
      throw new AuthError(
        `Token verification failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    if (payload.client_id !== cfg.expectedClientId) {
      throw new AuthError("Token client_id does not match registered client");
    }

    return payload;
  };
}

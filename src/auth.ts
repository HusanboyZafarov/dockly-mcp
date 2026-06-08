import crypto from "crypto";

const BASE_URL = process.env.BASE_URL || "https://dockly-mcp.up.railway.app";
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID ?? "";
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET ?? "";

export function isAuthEnabled(): boolean {
  return !!(GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET);
}

// ── Types ─────────────────────────────────────────────────────────────────

interface PendingAuth {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state: string;
}

interface AuthCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  githubUser: GitHubUser;
  expiresAt: number;
}

interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string;
}

interface AccessToken {
  token: string;
  clientId: string;
  githubUser: GitHubUser;
  createdAt: number;
}

// ── In-memory stores ──────────────────────────────────────────────────────

const pendingAuths = new Map<string, PendingAuth>();
const authCodes = new Map<string, AuthCode>();
const accessTokens = new Map<string, AccessToken>();

// ── OAuth Metadata (MCP spec) ─────────────────────────────────────────────

export function getResourceMetadata() {
  return {
    resource: BASE_URL,
    authorization_servers: [BASE_URL],
  };
}

export function getOAuthMetadata() {
  return {
    issuer: BASE_URL,
    authorization_endpoint: `${BASE_URL}/authorize`,
    token_endpoint: `${BASE_URL}/token`,
    revocation_endpoint: `${BASE_URL}/revoke`,
    registration_endpoint: `${BASE_URL}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  };
}

// ── Dynamic Client Registration (RFC 7591) ────────────────────────────────

export function registerClient(body: {
  client_name?: string;
  redirect_uris?: string[];
  grant_types?: string[];
  response_types?: string[];
  token_endpoint_auth_method?: string;
}) {
  const client_id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  const response = {
    client_id,
    client_name: body.client_name || "mcp-client",
    redirect_uris: body.redirect_uris || [],
    grant_types: body.grant_types || ["authorization_code"],
    response_types: body.response_types || ["code"],
    token_endpoint_auth_method: body.token_endpoint_auth_method || "none",
    client_id_issued_at: now,
  };

  console.log(`[AUTH] Client registered: ${client_id} (${response.client_name})`);
  return response;
}

// ── Authorization → redirect to GitHub ────────────────────────────────────

export function buildGitHubAuthUrl(params: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state: string;
}): string {
  const githubState = crypto.randomUUID();

  pendingAuths.set(githubState, {
    clientId: params.clientId,
    redirectUri: params.redirectUri,
    codeChallenge: params.codeChallenge,
    codeChallengeMethod: params.codeChallengeMethod,
    state: params.state,
  });

  console.log(`[AUTH] Authorize request: client=${params.clientId}, redirect_uri=${params.redirectUri}`);

  // Auto-expire pending auths after 10 minutes
  setTimeout(() => pendingAuths.delete(githubState), 10 * 60 * 1000);

  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", GITHUB_CLIENT_ID);
  url.searchParams.set("redirect_uri", `${BASE_URL}/callback`);
  url.searchParams.set("state", githubState);
  url.searchParams.set("scope", "read:user");

  return url.toString();
}

// ── GitHub Callback → issue auth code ─────────────────────────────────────

export async function handleGitHubCallback(
  code: string,
  githubState: string
): Promise<{ redirectUrl: string } | null> {
  const pending = pendingAuths.get(githubState);
  if (!pending) {
    console.error("[AUTH] Callback failed: no pending auth for state", githubState);
    return null;
  }
  pendingAuths.delete(githubState);

  // Exchange GitHub code for access token
  console.log("[AUTH] Exchanging GitHub code for token...");
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      client_secret: GITHUB_CLIENT_SECRET,
      code,
    }),
  });

  const tokenData = (await tokenRes.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };

  if (!tokenData.access_token) {
    console.error("[AUTH] GitHub token exchange failed:", tokenData.error, tokenData.error_description);
    return null;
  }

  // Fetch GitHub user profile
  const userRes = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      "User-Agent": "dockly-mcp",
    },
  });

  if (!userRes.ok) {
    console.error("[AUTH] GitHub user fetch failed:", userRes.status);
    return null;
  }

  const githubUser = (await userRes.json()) as GitHubUser;

  // Generate a short-lived auth code for the MCP client
  const authCode = crypto.randomUUID();
  authCodes.set(authCode, {
    clientId: pending.clientId,
    redirectUri: pending.redirectUri,
    codeChallenge: pending.codeChallenge,
    githubUser,
    expiresAt: Date.now() + 10 * 60 * 1000,
  });

  // Auto-expire
  setTimeout(() => authCodes.delete(authCode), 10 * 60 * 1000);

  // Build redirect back to the MCP client
  const separator = pending.redirectUri.includes("?") ? "&" : "?";
  const redirectUrl = `${pending.redirectUri}${separator}code=${encodeURIComponent(authCode)}&state=${encodeURIComponent(pending.state)}`;

  console.log(`[AUTH] GitHub user "${githubUser.login}" authenticated, redirecting to client`);

  return { redirectUrl };
}

// ── Token Exchange (with PKCE verification) ───────────────────────────────

export function exchangeCodeForToken(params: {
  code: string;
  codeVerifier: string;
  clientId: string;
  redirectUri?: string;
}): { access_token: string; token_type: string; expires_in: number } | { error: string; error_description?: string } {
  const stored = authCodes.get(params.code);

  if (!stored) {
    console.error("[AUTH] Token exchange failed: invalid or expired code");
    return { error: "invalid_grant", error_description: "Authorization code not found or expired" };
  }

  if (stored.expiresAt < Date.now()) {
    authCodes.delete(params.code);
    console.error("[AUTH] Token exchange failed: code expired");
    return { error: "invalid_grant", error_description: "Authorization code expired" };
  }

  if (stored.clientId !== params.clientId) {
    console.error(`[AUTH] Token exchange failed: client_id mismatch (expected ${stored.clientId}, got ${params.clientId})`);
    return { error: "invalid_client", error_description: "Client ID mismatch" };
  }

  // Verify PKCE: SHA256(code_verifier) must match stored code_challenge
  const hash = crypto
    .createHash("sha256")
    .update(params.codeVerifier)
    .digest("base64url");

  if (hash !== stored.codeChallenge) {
    console.error("[AUTH] Token exchange failed: PKCE verification failed");
    return { error: "invalid_grant", error_description: "PKCE verification failed" };
  }

  // Issue access token
  const token = crypto.randomUUID();
  accessTokens.set(token, {
    token,
    clientId: params.clientId,
    githubUser: stored.githubUser,
    createdAt: Date.now(),
  });

  authCodes.delete(params.code);

  console.log(`[AUTH] Token issued for "${stored.githubUser.login}"`);

  return {
    access_token: token,
    token_type: "bearer",
    expires_in: 3600 * 24 * 7, // 7 days
  };
}

// ── Token Validation ──────────────────────────────────────────────────────

export function validateToken(
  authHeader: string | undefined
): AccessToken | null {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  return accessTokens.get(token) ?? null;
}

// ── Token Revocation ──────────────────────────────────────────────────────

export function revokeToken(token: string): boolean {
  return accessTokens.delete(token);
}

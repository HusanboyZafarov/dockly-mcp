import crypto from "crypto";

const BASE_URL = process.env.BASE_URL || "https://pretty-analysis-production-b53e.up.railway.app";
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID ?? "";
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET ?? "";

export function isAuthEnabled(): boolean {
  return !!(GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET);
}

// ── Types ─────────────────────────────────────────────────────────────────

interface RegisteredClient {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
}

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

const registeredClients = new Map<string, RegisteredClient>();
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

// ── Dynamic Client Registration ───────────────────────────────────────────

export function registerClient(body: {
  client_name?: string;
  redirect_uris: string[];
}): RegisteredClient {
  const client_id = crypto.randomUUID();
  const client: RegisteredClient = {
    client_id,
    client_name: body.client_name,
    redirect_uris: body.redirect_uris,
  };
  registeredClients.set(client_id, client);
  return client;
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
  if (!pending) return null;
  pendingAuths.delete(githubState);

  // Exchange GitHub code for access token
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
  };
  if (!tokenData.access_token) return null;

  // Fetch GitHub user profile
  const userRes = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      "User-Agent": "dockly-mcp",
    },
  });
  if (!userRes.ok) return null;
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

  // Redirect back to the MCP client's redirect_uri
  const redirectUrl = new URL(pending.redirectUri);
  redirectUrl.searchParams.set("code", authCode);
  redirectUrl.searchParams.set("state", pending.state);

  console.log(`[AUTH] GitHub user "${githubUser.login}" authenticated`);

  return { redirectUrl: redirectUrl.toString() };
}

// ── Token Exchange (with PKCE verification) ───────────────────────────────

export function exchangeCodeForToken(params: {
  code: string;
  codeVerifier: string;
  clientId: string;
  redirectUri: string;
}): { access_token: string; token_type: string } | { error: string } {
  const stored = authCodes.get(params.code);
  if (!stored) return { error: "invalid_grant" };

  if (stored.expiresAt < Date.now()) {
    authCodes.delete(params.code);
    return { error: "invalid_grant" };
  }

  if (stored.clientId !== params.clientId) return { error: "invalid_client" };
  if (stored.redirectUri !== params.redirectUri) return { error: "invalid_grant" };

  // Verify PKCE: SHA256(code_verifier) must match stored code_challenge
  const hash = crypto
    .createHash("sha256")
    .update(params.codeVerifier)
    .digest("base64url");

  if (hash !== stored.codeChallenge) return { error: "invalid_grant" };

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

  return { access_token: token, token_type: "Bearer" };
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

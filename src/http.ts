#!/usr/bin/env node

import express from "express";
import cors from "cors";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createServer } from "./server.js";
import {
  isAuthEnabled,
  getResourceMetadata,
  getOAuthMetadata,
  registerClient,
  buildGitHubAuthUrl,
  handleGitHubCallback,
  exchangeCodeForToken,
  validateToken,
  revokeToken,
} from "./auth.js";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const BASE_URL = process.env.BASE_URL || "https://dockly-mcp.up.railway.app";

// Track active sessions: sessionId -> transport
const sessions = new Map<string, SSEServerTransport>();

// ── OAuth Discovery (MCP spec) ───────────────────────────────────────────

app.get("/.well-known/oauth-protected-resource", (_req, res) => {
  res.json(getResourceMetadata());
});

app.get("/.well-known/oauth-authorization-server", (_req, res) => {
  res.json(getOAuthMetadata());
});

// ── Dynamic Client Registration ──────────────────────────────────────────

app.post("/register", (req, res) => {
  const { client_name, redirect_uris } = req.body;
  if (!redirect_uris || !Array.isArray(redirect_uris)) {
    res.status(400).json({ error: "redirect_uris is required" });
    return;
  }
  const client = registerClient({ client_name, redirect_uris });
  res.status(201).json(client);
});

// ── Authorization endpoint → redirects to GitHub ─────────────────────────

app.get("/authorize", (req, res) => {
  if (!isAuthEnabled()) {
    res.status(501).json({ error: "Auth not configured. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET." });
    return;
  }

  const { response_type, client_id, redirect_uri, code_challenge, code_challenge_method, state } = req.query;

  if (response_type !== "code") {
    res.status(400).json({ error: "unsupported_response_type" });
    return;
  }

  if (!client_id || !redirect_uri || !code_challenge || !state) {
    res.status(400).json({ error: "invalid_request", error_description: "Missing required parameters: client_id, redirect_uri, code_challenge, state" });
    return;
  }

  const githubUrl = buildGitHubAuthUrl({
    clientId: client_id as string,
    redirectUri: redirect_uri as string,
    codeChallenge: code_challenge as string,
    codeChallengeMethod: (code_challenge_method as string) || "S256",
    state: state as string,
  });

  res.redirect(githubUrl);
});

// ── GitHub OAuth Callback ────────────────────────────────────────────────

app.get("/callback", async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    res.status(400).send(`GitHub authorization denied: ${error}`);
    return;
  }

  if (!code || !state) {
    res.status(400).send("Missing code or state from GitHub.");
    return;
  }

  try {
    const result = await handleGitHubCallback(code as string, state as string);
    if (!result) {
      res.status(400).send("Authentication failed. The link may have expired — please try connecting again.");
      return;
    }
    res.redirect(result.redirectUrl);
  } catch (err) {
    console.error("[AUTH] Callback error:", err);
    res.status(500).send("Authentication error. Please try again.");
  }
});

// ── Token Exchange ───────────────────────────────────────────────────────

app.post("/token", (req, res) => {
  const { grant_type, code, code_verifier, client_id, redirect_uri } = req.body;

  if (grant_type !== "authorization_code") {
    res.status(400).json({ error: "unsupported_grant_type" });
    return;
  }

  if (!code || !code_verifier || !client_id || !redirect_uri) {
    res.status(400).json({ error: "invalid_request" });
    return;
  }

  const result = exchangeCodeForToken({
    code,
    codeVerifier: code_verifier,
    clientId: client_id,
    redirectUri: redirect_uri,
  });

  if ("error" in result) {
    res.status(400).json(result);
    return;
  }

  res.json(result);
});

// ── Token Revocation ─────────────────────────────────────────────────────

app.post("/revoke", (req, res) => {
  const { token } = req.body;
  if (token) revokeToken(token);
  res.status(200).end();
});

// ── Auth Middleware ──────────────────────────────────────────────────────

function requireAuth(req: express.Request, res: express.Response): boolean {
  if (!isAuthEnabled()) return true;

  const session = validateToken(req.headers.authorization);
  if (!session) {
    res
      .status(401)
      .set("WWW-Authenticate", `Bearer resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource"`)
      .json({ error: "unauthorized", hint: "Connect via an MCP client that supports OAuth, or set up GitHub OAuth." });
    return false;
  }

  return true;
}

// ── Health / Info (no auth) ──────────────────────────────────────────────

app.get("/", (_req, res) => {
  res.json({
    name: "dockly-mcp",
    version: "1.0.0",
    status: "running",
    auth: isAuthEnabled() ? "github-oauth" : "disabled",
    activeSessions: sessions.size,
    endpoints: {
      sse: "GET /sse",
      messages: "POST /messages?sessionId=<id>",
    },
  });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// ── SSE endpoint ─────────────────────────────────────────────────────────

app.get("/sse", async (req, res) => {
  if (!requireAuth(req, res)) return;

  const { server } = createServer();
  const transport = new SSEServerTransport("/messages", res);
  sessions.set(transport.sessionId, transport);

  console.log(`[SSE] New session: ${transport.sessionId}`);

  req.on("close", () => {
    console.log(`[SSE] Session closed: ${transport.sessionId}`);
    sessions.delete(transport.sessionId);
  });

  await server.connect(transport);
});

// ── Messages endpoint ────────────────────────────────────────────────────

app.post("/messages", async (req, res) => {
  if (!requireAuth(req, res)) return;

  const sessionId = req.query.sessionId as string;
  const transport = sessions.get(sessionId);

  if (!transport) {
    res.status(404).json({ error: "Session not found. Connect to /sse first." });
    return;
  }

  await transport.handlePostMessage(req, res);
});

// ── Start ────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "3100", 10);

app.listen(PORT, "0.0.0.0", () => {
  const authStatus = isAuthEnabled()
    ? "GitHub OAuth enabled"
    : "disabled (set GITHUB_CLIENT_ID & GITHUB_CLIENT_SECRET to enable)";

  console.log(`
  ╔══════════════════════════════════════════════╗
  ║         dockly-mcp server (HTTP/SSE)         ║
  ╠══════════════════════════════════════════════╣
  ║  Local:   http://localhost:${PORT}              ║
  ║  SSE:     http://localhost:${PORT}/sse           ║
  ║  Health:  http://localhost:${PORT}/health        ║
  ╚══════════════════════════════════════════════╝
  Auth: ${authStatus}
  `);
});

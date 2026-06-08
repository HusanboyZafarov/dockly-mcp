#!/usr/bin/env node

import express from "express";
import cors from "cors";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createServer } from "./server.js";

const app = express();
app.use(cors());

// Track active sessions: sessionId -> transport
const sessions = new Map<string, SSEServerTransport>();

// Health check
app.get("/", (_req, res) => {
  res.json({
    name: "api-docs-mcp",
    version: "1.0.0",
    status: "running",
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

// SSE endpoint — client connects here to establish a session
app.get("/sse", async (req, res) => {
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

// Messages endpoint — client sends tool calls here
app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId as string;
  const transport = sessions.get(sessionId);

  if (!transport) {
    res.status(404).json({ error: "Session not found. Connect to /sse first." });
    return;
  }

  await transport.handlePostMessage(req, res);
});

const PORT = parseInt(process.env.PORT ?? "3100", 10);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`
  ╔══════════════════════════════════════════════╗
  ║       api-docs-mcp server (HTTP/SSE)        ║
  ╠══════════════════════════════════════════════╣
  ║  Local:   http://localhost:${PORT}              ║
  ║  SSE:     http://localhost:${PORT}/sse           ║
  ║  Health:  http://localhost:${PORT}/health        ║
  ╚══════════════════════════════════════════════╝
  `);
});

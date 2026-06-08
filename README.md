# Dockly MCP

An MCP (Model Context Protocol) server that fetches, parses, and exposes API documentation for AI assistants. Paste a Postman Collection or OpenAPI spec URL and any AI can explore, search, and test your APIs.

**Live Server:** `https://dockly-mcp.up.railway.app/sse`

**Auth:** GitHub OAuth 2.1 (MCP spec-compliant)

## Supported Formats

- Postman Collection v2.1 (JSON)
- OpenAPI 3.x (JSON / YAML)
- Raw GitHub URLs, Gist URLs, any direct link to a spec file

## Available Tools

| Tool | Description |
|------|-------------|
| `load_api_docs` | Load API docs from a URL (Postman/OpenAPI) |
| `load_api_docs_from_text` | Parse raw JSON/YAML content directly |
| `list_endpoints` | List all endpoints, filter by folder or HTTP method |
| `search_endpoints` | Search across names, URLs, descriptions |
| `get_endpoint` | Full endpoint details (headers, body, params, responses) |
| `list_folders` | Show the folder/tag tree structure |
| `get_collection_info` | Collection metadata and method breakdown |
| `test_endpoint` | Make a real HTTP request and get the response |
| `generate_curl` | Generate a cURL command without making the request |
| `get_request_body_schema` | Get the request body example for an endpoint |
| `get_response_examples` | Get all response examples for an endpoint |

## Quick Start

### Use the hosted version (no setup needed)

Add to your MCP client config (`.mcp.json`, Claude Desktop config, etc.):

```json
{
  "mcpServers": {
    "dockly": {
      "type": "sse",
      "url": "https://dockly-mcp.up.railway.app/sse"
    }
  }
}
```

Or via Claude Code CLI:

```bash
claude mcp add dockly --transport sse https://dockly-mcp.up.railway.app/sse
```

On first connect, your MCP client will open a browser for GitHub login. Authorize once and you're in.

### Run locally (stdio mode)

```bash
git clone https://github.com/HusanboyZafarov/dockly-mcp.git
cd dockly-mcp
npm install
npm run build
```

Add to your MCP config:

```json
{
  "mcpServers": {
    "dockly": {
      "command": "node",
      "args": ["/path/to/dockly-mcp/dist/index.js"]
    }
  }
}
```

> Stdio mode has no auth — it runs locally on your machine.

### Run locally (HTTP/SSE mode)

```bash
npm run start:http
# Server runs at http://localhost:3100
# SSE endpoint: http://localhost:3100/sse
```

> Auth is disabled by default in local mode. Set the env vars below to enable it.

## Authentication

Dockly uses **OAuth 2.1 with GitHub** login, fully compliant with the [MCP authorization spec](https://modelcontextprotocol.io/specification/2025-03-26/basic/authorization).

**How it works:**

1. MCP client connects to `/sse`
2. Server returns `401` with OAuth metadata
3. Client auto-opens browser -> user logs in with GitHub
4. Done — no API keys, no tokens to copy

**To enable auth on your own deployment:**

1. Create a [GitHub OAuth App](https://github.com/settings/developers):
   - **Homepage URL:** your server URL
   - **Callback URL:** `https://your-domain.com/callback`

2. Set environment variables:
   ```
   GITHUB_CLIENT_ID=your_client_id
   GITHUB_CLIENT_SECRET=your_client_secret
   BASE_URL=https://your-domain.com
   ```

If `GITHUB_CLIENT_ID` is not set, auth is disabled and the server runs open (good for local dev).

## Usage Example

Once connected, any AI assistant can:

1. **Load docs** — `load_api_docs({ url: "https://petstore3.swagger.io/api/v3/openapi.json" })`
2. **Browse** — `list_endpoints()` or `list_endpoints({ method: "POST" })`
3. **Search** — `search_endpoints({ query: "user" })`
4. **Inspect** — `get_endpoint({ name: "createUser" })`
5. **Test** — `test_endpoint({ name: "listPets", base_url: "https://petstore3.swagger.io/api/v3" })`
6. **Export** — `generate_curl({ name: "listPets", base_url: "https://petstore3.swagger.io/api/v3" })`

## Compatible MCP Clients

- Claude Code (CLI)
- Claude Desktop
- Cursor
- Windsurf
- Any MCP-compatible AI client

## Self-Hosting

### Docker

```bash
docker build -t dockly-mcp .
docker run -p 3100:3100 \
  -e GITHUB_CLIENT_ID=xxx \
  -e GITHUB_CLIENT_SECRET=xxx \
  -e BASE_URL=https://your-domain.com \
  dockly-mcp
```

### Railway

```bash
npm i -g @railway/cli
railway login
railway init
railway up
railway domain
```

Set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `BASE_URL` in Railway variables.

### Render

1. Connect your GitHub repo on render.com
2. Build Command: `npm ci && npm run build`
3. Start Command: `npm run start:http`
4. Environment: `PORT=3100`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `BASE_URL`

## Tech Stack

- TypeScript + Node.js
- [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk)
- Express (HTTP/SSE transport)
- GitHub OAuth 2.1 with PKCE
- js-yaml (YAML parsing)
- Zod (schema validation)

## License

MIT

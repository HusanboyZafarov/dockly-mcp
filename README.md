# API Docs MCP Server

An MCP (Model Context Protocol) server that fetches, parses, and exposes API documentation for AI assistants. Paste a Postman Collection or OpenAPI spec URL and any AI can explore, search, and test your APIs.

**Live Server:** `https://pretty-analysis-production-b53e.up.railway.app/sse`

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

Add to your MCP client config:

```json
{
  "mcpServers": {
    "api-docs": {
      "url": "https://pretty-analysis-production-b53e.up.railway.app/sse"
    }
  }
}
```

### Run locally (stdio mode)

```bash
git clone https://github.com/HusanboyZafarov/api-docs-mcp-server.git
cd api-docs-mcp-server
npm install
npm run build
```

Add to your MCP config:

```json
{
  "mcpServers": {
    "api-docs": {
      "command": "node",
      "args": ["/path/to/api-docs-mcp-server/dist/index.js"]
    }
  }
}
```

### Run locally (HTTP/SSE mode)

```bash
npm run start:http
# Server runs at http://localhost:3100
# SSE endpoint: http://localhost:3100/sse
```

## Usage Example

Once connected, any AI assistant can:

1. **Load docs** — `load_api_docs({ url: "https://petstore3.swagger.io/api/v3/openapi.json" })`
2. **Browse** — `list_endpoints()` or `list_endpoints({ method: "POST" })`
3. **Search** — `search_endpoints({ query: "user" })`
4. **Inspect** — `get_endpoint({ name: "createUser" })`
5. **Test** — `test_endpoint({ name: "listPets", base_url: "https://petstore3.swagger.io/api/v3" })`
6. **Export** — `generate_curl({ name: "listPets", base_url: "https://petstore3.swagger.io/api/v3" })`

## Compatible MCP Clients

- Claude Desktop
- Claude Code (CLI)
- Cursor
- Windsurf
- Any MCP-compatible AI client

## Self-Hosting

### Docker

```bash
docker build -t api-docs-mcp .
docker run -p 3100:3100 api-docs-mcp
```

### Railway

```bash
npm i -g @railway/cli
railway login
railway init
railway up
railway domain
```

### Render

1. Connect your GitHub repo on render.com
2. Build Command: `npm ci && npm run build`
3. Start Command: `npm run start:http`
4. Environment: `PORT=3100`

## Tech Stack

- TypeScript + Node.js
- [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk)
- Express (HTTP/SSE transport)
- js-yaml (YAML parsing)
- Zod (schema validation)

## License

MIT

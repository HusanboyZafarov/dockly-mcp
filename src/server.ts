import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { parseContent, flattenCollection, getFolderTree } from "./parser.js";
import type { PostmanCollection, FlatEndpoint } from "./types.js";

// ── Per-session state ────────────────────────────────────────────────────

interface SessionState {
  collection: PostmanCollection | null;
  endpoints: FlatEndpoint[];
  sourceUrl: string | null;
}

// ── Create a fresh MCP server instance (one per session for HTTP) ────────

export function createServer(): { server: McpServer; state: SessionState } {
  const state: SessionState = {
    collection: null,
    endpoints: [],
    sourceUrl: null,
  };

  const server = new McpServer({
    name: "api-docs-mcp",
    version: "1.0.0",
  });

  // ── Tool: load_api_docs ────────────────────────────────────────────────

  server.tool(
    "load_api_docs",
    "Load API documentation from a URL. Supports Postman Collection JSON, OpenAPI 3.x JSON/YAML. Paste any raw URL to your API docs.",
    {
      url: z.string().describe("URL to the API documentation (Postman collection JSON URL, OpenAPI spec URL, raw GitHub URL, etc.)"),
    },
    async ({ url }) => {
      try {
        const response = await fetch(url, {
          headers: { Accept: "application/json, application/x-yaml, text/yaml, text/plain, */*" },
        });

        if (!response.ok) {
          return { content: [{ type: "text", text: `Failed to fetch: ${response.status} ${response.statusText}` }] };
        }

        const text = await response.text();
        const contentType = response.headers.get("content-type") ?? "";

        const collection = parseContent(text, contentType);
        if (!collection) {
          return { content: [{ type: "text", text: "Could not parse the document. Supported formats: Postman Collection v2.1, OpenAPI 3.x (JSON/YAML)." }] };
        }

        state.collection = collection;
        state.endpoints = flattenCollection(collection.item);
        state.sourceUrl = url;

        const folders = getFolderTree(collection.item);
        const folderSummary = folders
          .map((f) => `  - ${f.name} (${f.endpointCount} endpoints)`)
          .join("\n");

        return {
          content: [{
            type: "text",
            text: [
              `Successfully loaded: ${collection.info.name}`,
              collection.info.description ? `Description: ${collection.info.description}` : "",
              `Total endpoints: ${state.endpoints.length}`,
              `Folders:\n${folderSummary}`,
              "",
              "Use list_endpoints, search_endpoints, get_endpoint, list_folders, or test_endpoint to explore.",
            ].filter(Boolean).join("\n"),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error loading docs: ${err instanceof Error ? err.message : String(err)}` }] };
      }
    }
  );

  // ── Tool: load_api_docs_from_text ──────────────────────────────────────

  server.tool(
    "load_api_docs_from_text",
    "Load API documentation from raw text content (paste the JSON/YAML directly instead of a URL).",
    {
      content: z.string().describe("Raw Postman Collection JSON or OpenAPI 3.x JSON/YAML content"),
      format: z.enum(["json", "yaml"]).default("json").describe("Format of the content"),
    },
    async ({ content, format }) => {
      const collection = parseContent(content, format === "yaml" ? "application/yaml" : "application/json");
      if (!collection) {
        return { content: [{ type: "text", text: "Could not parse the content. Supported formats: Postman Collection v2.1, OpenAPI 3.x (JSON/YAML)." }] };
      }

      state.collection = collection;
      state.endpoints = flattenCollection(collection.item);
      state.sourceUrl = null;

      return {
        content: [{
          type: "text",
          text: [
            `Successfully loaded: ${collection.info.name}`,
            `Total endpoints: ${state.endpoints.length}`,
            "Use list_endpoints, search_endpoints, get_endpoint, list_folders, or test_endpoint to explore.",
          ].join("\n"),
        }],
      };
    }
  );

  // ── Tool: list_endpoints ───────────────────────────────────────────────

  server.tool(
    "list_endpoints",
    "List all API endpoints in the loaded collection. Optionally filter by folder or HTTP method.",
    {
      folder: z.string().optional().describe("Filter by folder name (case-insensitive partial match)"),
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]).optional().describe("Filter by HTTP method"),
    },
    async ({ folder, method }) => {
      if (!state.collection) {
        return { content: [{ type: "text", text: "No API docs loaded. Use load_api_docs first." }] };
      }

      let endpoints = state.endpoints;

      if (folder) {
        const f = folder.toLowerCase();
        endpoints = endpoints.filter((e) => e.folder.toLowerCase().includes(f));
      }
      if (method) {
        endpoints = endpoints.filter((e) => e.method === method);
      }

      if (endpoints.length === 0) {
        return { content: [{ type: "text", text: "No endpoints match the given filters." }] };
      }

      const lines = endpoints.map(
        (e) => `[${e.method.padEnd(7)}] ${e.url}  —  ${e.name}${e.folder ? `  (${e.folder})` : ""}`
      );

      return {
        content: [{
          type: "text",
          text: `Found ${endpoints.length} endpoint(s):\n\n${lines.join("\n")}`,
        }],
      };
    }
  );

  // ── Tool: search_endpoints ─────────────────────────────────────────────

  server.tool(
    "search_endpoints",
    "Search endpoints by keyword across name, URL, description, and folder.",
    {
      query: z.string().describe("Search keyword"),
    },
    async ({ query }) => {
      if (!state.collection) {
        return { content: [{ type: "text", text: "No API docs loaded. Use load_api_docs first." }] };
      }

      const q = query.toLowerCase();
      const matches = state.endpoints.filter(
        (e) =>
          e.name.toLowerCase().includes(q) ||
          e.url.toLowerCase().includes(q) ||
          e.folder.toLowerCase().includes(q) ||
          (e.description?.toLowerCase().includes(q) ?? false)
      );

      if (matches.length === 0) {
        return { content: [{ type: "text", text: `No endpoints matching "${query}".` }] };
      }

      const lines = matches.map(
        (e) => `[${e.method.padEnd(7)}] ${e.url}  —  ${e.name}`
      );

      return {
        content: [{
          type: "text",
          text: `Found ${matches.length} result(s) for "${query}":\n\n${lines.join("\n")}`,
        }],
      };
    }
  );

  // ── Tool: get_endpoint ─────────────────────────────────────────────────

  server.tool(
    "get_endpoint",
    "Get full details of a specific endpoint by name or URL pattern.",
    {
      name: z.string().describe("Endpoint name or URL substring to match"),
    },
    async ({ name }) => {
      if (!state.collection) {
        return { content: [{ type: "text", text: "No API docs loaded. Use load_api_docs first." }] };
      }

      const q = name.toLowerCase();
      const match = state.endpoints.find(
        (e) =>
          e.name.toLowerCase() === q ||
          e.name.toLowerCase().includes(q) ||
          e.url.toLowerCase().includes(q) ||
          e.id.toLowerCase().includes(q)
      );

      if (!match) {
        return { content: [{ type: "text", text: `No endpoint found matching "${name}".` }] };
      }

      const sections: string[] = [
        `## ${match.method} ${match.name}`,
        "",
        `**URL:** ${match.url}`,
        `**Folder:** ${match.folder || "(root)"}`,
      ];

      if (match.description) {
        sections.push("", `**Description:** ${match.description}`);
      }

      if (match.headers.length > 0) {
        sections.push("", "**Headers:**");
        for (const h of match.headers) {
          sections.push(`  ${h.key}: ${h.value}`);
        }
      }

      if (match.parameters && match.parameters.length > 0) {
        sections.push("", "**Parameters:**");
        for (const p of match.parameters) {
          const req = p.required ? " (required)" : "";
          const type = p.schema?.type ? ` [${p.schema.type}]` : "";
          sections.push(`  - ${p.name} (${p.in})${type}${req}${p.description ? `: ${p.description}` : ""}`);
        }
      }

      if (match.body) {
        sections.push("", "**Request Body:**", "```json", match.body, "```");
      }

      if (match.responses.length > 0) {
        sections.push("", "**Responses:**");
        for (const r of match.responses) {
          sections.push(`\n### ${r.name} (${r.code})`);
          if (r.body) {
            sections.push("```json", r.body, "```");
          }
        }
      }

      return { content: [{ type: "text", text: sections.join("\n") }] };
    }
  );

  // ── Tool: list_folders ─────────────────────────────────────────────────

  server.tool(
    "list_folders",
    "List the folder/tag structure of the loaded API collection.",
    {},
    async () => {
      if (!state.collection) {
        return { content: [{ type: "text", text: "No API docs loaded. Use load_api_docs first." }] };
      }

      const folders = getFolderTree(state.collection.item);

      function renderTree(nodes: typeof folders, indent = ""): string {
        return nodes
          .map((f) => {
            const desc = f.description ? ` — ${f.description}` : "";
            const line = `${indent}- ${f.name} (${f.endpointCount} endpoints)${desc}`;
            const sub = f.subfolders.length > 0 ? "\n" + renderTree(f.subfolders, indent + "  ") : "";
            return line + sub;
          })
          .join("\n");
      }

      return {
        content: [{
          type: "text",
          text: `Collection: ${state.collection.info.name}\n\n${renderTree(folders)}`,
        }],
      };
    }
  );

  // ── Tool: get_collection_info ──────────────────────────────────────────

  server.tool(
    "get_collection_info",
    "Get metadata about the currently loaded API collection.",
    {},
    async () => {
      if (!state.collection) {
        return { content: [{ type: "text", text: "No API docs loaded. Use load_api_docs first." }] };
      }

      const methods: Record<string, number> = {};
      for (const e of state.endpoints) {
        methods[e.method] = (methods[e.method] ?? 0) + 1;
      }

      const methodSummary = Object.entries(methods)
        .sort(([, a], [, b]) => b - a)
        .map(([m, c]) => `  ${m}: ${c}`)
        .join("\n");

      const variables = state.collection.variable
        .map((v) => `  {{${v.key}}} = ${v.value}`)
        .join("\n");

      return {
        content: [{
          type: "text",
          text: [
            `Name: ${state.collection.info.name}`,
            state.collection.info.description ? `Description: ${state.collection.info.description}` : "",
            state.sourceUrl ? `Source: ${state.sourceUrl}` : "",
            `Total endpoints: ${state.endpoints.length}`,
            "",
            `Methods:\n${methodSummary}`,
            variables ? `\nVariables:\n${variables}` : "",
          ].filter(Boolean).join("\n"),
        }],
      };
    }
  );

  // ── Tool: test_endpoint ────────────────────────────────────────────────

  server.tool(
    "test_endpoint",
    "Make a real HTTP request to test an API endpoint. Requires the docs to be loaded first.",
    {
      name: z.string().describe("Endpoint name or URL substring to match"),
      base_url: z.string().optional().describe("Base URL to prepend (e.g. https://api.example.com). Required if URLs use variables like {{baseUrl}}."),
      headers: z.record(z.string()).optional().describe("Additional headers as key-value pairs"),
      body: z.string().optional().describe("Request body JSON string (overrides the default from the collection)"),
    },
    async ({ name, base_url, headers: extraHeaders, body: customBody }) => {
      if (!state.collection) {
        return { content: [{ type: "text", text: "No API docs loaded. Use load_api_docs first." }] };
      }

      const q = name.toLowerCase();
      const match = state.endpoints.find(
        (e) =>
          e.name.toLowerCase() === q ||
          e.name.toLowerCase().includes(q) ||
          e.url.toLowerCase().includes(q)
      );

      if (!match) {
        return { content: [{ type: "text", text: `No endpoint found matching "${name}".` }] };
      }

      let url = match.url;
      url = url.replace(/\{\{baseUrl\}\}/g, base_url ?? "");
      url = url.replace(/\{\{[^}]+\}\}/g, "");

      if (!url.startsWith("http")) {
        if (base_url) {
          url = base_url.replace(/\/$/, "") + "/" + url.replace(/^\//, "");
        } else {
          return {
            content: [{
              type: "text",
              text: `URL "${match.url}" needs a base_url. Provide base_url parameter (e.g. "https://api.example.com").`,
            }],
          };
        }
      }

      const reqHeaders: Record<string, string> = {};
      for (const h of match.headers) {
        reqHeaders[h.key] = h.value;
      }
      if (extraHeaders) {
        Object.assign(reqHeaders, extraHeaders);
      }

      const bodyContent = customBody ?? match.body;
      const fetchOptions: RequestInit = {
        method: match.method,
        headers: reqHeaders,
      };
      if (bodyContent && !["GET", "HEAD"].includes(match.method)) {
        fetchOptions.body = bodyContent;
      }

      const start = Date.now();
      try {
        const response = await fetch(url, fetchOptions);
        const elapsed = Date.now() - start;
        const responseText = await response.text();

        let formattedBody: string;
        try {
          formattedBody = JSON.stringify(JSON.parse(responseText), null, 2);
        } catch {
          formattedBody = responseText.slice(0, 2000);
        }

        const curlParts = [`curl -X ${match.method} '${url}'`];
        for (const [k, v] of Object.entries(reqHeaders)) {
          curlParts.push(`  -H '${k}: ${v}'`);
        }
        if (bodyContent && !["GET", "HEAD"].includes(match.method)) {
          curlParts.push(`  -d '${bodyContent.replace(/'/g, "'\\''")}'`);
        }
        const curlCmd = curlParts.join(" \\\n");

        return {
          content: [{
            type: "text",
            text: [
              `## Test: ${match.method} ${match.name}`,
              `**URL:** ${url}`,
              `**Status:** ${response.status} ${response.statusText}`,
              `**Time:** ${elapsed}ms`,
              "",
              "**Response:**",
              "```json",
              formattedBody,
              "```",
              "",
              "**cURL:**",
              "```bash",
              curlCmd,
              "```",
            ].join("\n"),
          }],
        };
      } catch (err) {
        const elapsed = Date.now() - start;
        return {
          content: [{
            type: "text",
            text: `Request failed after ${elapsed}ms: ${err instanceof Error ? err.message : String(err)}`,
          }],
        };
      }
    }
  );

  // ── Tool: generate_curl ────────────────────────────────────────────────

  server.tool(
    "generate_curl",
    "Generate a cURL command for any endpoint without actually making the request.",
    {
      name: z.string().describe("Endpoint name or URL substring to match"),
      base_url: z.string().optional().describe("Base URL to prepend"),
    },
    async ({ name, base_url }) => {
      if (!state.collection) {
        return { content: [{ type: "text", text: "No API docs loaded. Use load_api_docs first." }] };
      }

      const q = name.toLowerCase();
      const match = state.endpoints.find(
        (e) =>
          e.name.toLowerCase() === q ||
          e.name.toLowerCase().includes(q) ||
          e.url.toLowerCase().includes(q)
      );

      if (!match) {
        return { content: [{ type: "text", text: `No endpoint found matching "${name}".` }] };
      }

      let url = match.url;
      url = url.replace(/\{\{baseUrl\}\}/g, base_url ?? "{{baseUrl}}");

      if (!url.startsWith("http") && base_url) {
        url = base_url.replace(/\/$/, "") + "/" + url.replace(/^\//, "");
      }

      const parts = [`curl -X ${match.method} '${url}'`];
      for (const h of match.headers) {
        parts.push(`  -H '${h.key}: ${h.value}'`);
      }
      if (match.body && !["GET", "HEAD"].includes(match.method)) {
        parts.push(`  -d '${match.body.replace(/'/g, "'\\''")}'`);
      }

      return {
        content: [{
          type: "text",
          text: "```bash\n" + parts.join(" \\\n") + "\n```",
        }],
      };
    }
  );

  // ── Tool: get_request_body_schema ──────────────────────────────────────

  server.tool(
    "get_request_body_schema",
    "Get the request body example/schema for a specific endpoint.",
    {
      name: z.string().describe("Endpoint name or URL substring to match"),
    },
    async ({ name }) => {
      if (!state.collection) {
        return { content: [{ type: "text", text: "No API docs loaded. Use load_api_docs first." }] };
      }

      const q = name.toLowerCase();
      const match = state.endpoints.find(
        (e) =>
          e.name.toLowerCase() === q ||
          e.name.toLowerCase().includes(q) ||
          e.url.toLowerCase().includes(q)
      );

      if (!match) {
        return { content: [{ type: "text", text: `No endpoint found matching "${name}".` }] };
      }

      if (!match.body) {
        return { content: [{ type: "text", text: `${match.method} ${match.name} has no request body.` }] };
      }

      return {
        content: [{
          type: "text",
          text: `## Request Body: ${match.method} ${match.name}\n\n\`\`\`json\n${match.body}\n\`\`\``,
        }],
      };
    }
  );

  // ── Tool: get_response_examples ────────────────────────────────────────

  server.tool(
    "get_response_examples",
    "Get all response examples for a specific endpoint.",
    {
      name: z.string().describe("Endpoint name or URL substring to match"),
    },
    async ({ name }) => {
      if (!state.collection) {
        return { content: [{ type: "text", text: "No API docs loaded. Use load_api_docs first." }] };
      }

      const q = name.toLowerCase();
      const match = state.endpoints.find(
        (e) =>
          e.name.toLowerCase() === q ||
          e.name.toLowerCase().includes(q) ||
          e.url.toLowerCase().includes(q)
      );

      if (!match) {
        return { content: [{ type: "text", text: `No endpoint found matching "${name}".` }] };
      }

      if (match.responses.length === 0) {
        return { content: [{ type: "text", text: `${match.method} ${match.name} has no response examples.` }] };
      }

      const sections = match.responses.map((r) => {
        const body = r.body ? `\n\`\`\`json\n${r.body}\n\`\`\`` : "\n(no body)";
        return `### ${r.name} (${r.code})${body}`;
      });

      return {
        content: [{
          type: "text",
          text: `## Responses: ${match.method} ${match.name}\n\n${sections.join("\n\n")}`,
        }],
      };
    }
  );

  return { server, state };
}

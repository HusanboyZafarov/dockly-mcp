import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile } from "fs/promises";
import { parseContent, flattenCollection, getFolderTree } from "./parser.js";
import type { PostmanCollection, FlatEndpoint } from "./types.js";

// ── Per-session state ────────────────────────────────────────────────────

interface SessionState {
  collection: PostmanCollection | null;
  endpoints: FlatEndpoint[];
  sourceUrl: string | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Resolve {{variable}} placeholders from collection variables */
function resolveVariables(text: string, variables: { key: string; value: string }[]): string {
  return text.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    const v = variables.find((vr) => vr.key === key);
    return v ? v.value : match;
  });
}

/** Infer a JSON-like schema table from an example value */
function inferSchema(value: unknown, prefix = ""): string[] {
  const lines: string[] = [];

  if (value === null || value === undefined) return lines;

  if (Array.isArray(value)) {
    lines.push(`| ${prefix || "(root)"} | array | — | — |`);
    if (value.length > 0) {
      lines.push(...inferSchema(value[0], `${prefix}[]`));
    }
    return lines;
  }

  if (typeof value === "object") {
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      const fieldPath = prefix ? `${prefix}.${key}` : key;
      const type = val === null ? "null" : Array.isArray(val) ? "array" : typeof val;
      const example = type === "object" || type === "array" ? "" : JSON.stringify(val);
      lines.push(`| ${fieldPath} | ${type} | — | ${example} |`);
      if (type === "object" && val !== null) {
        lines.push(...inferSchema(val, fieldPath));
      } else if (type === "array" && Array.isArray(val) && val.length > 0) {
        lines.push(...inferSchema(val[0], `${fieldPath}[]`));
      }
    }
  }

  return lines;
}

/** Detect Postman Documenter URL and extract userId + slug */
function parseDocumenterUrl(url: string): { userId: string; slug: string } | null {
  const match = url.match(/documenter\.getpostman\.com\/view\/(\d+)\/([^/?#]+)/);
  return match ? { userId: match[1], slug: match[2] } : null;
}

/** Provide a more specific error message for fetch failures */
function describeFetchError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("ECONNREFUSED")) return `Connection refused — the server is not running or not reachable. (${msg})`;
  if (msg.includes("ENOTFOUND") || msg.includes("getaddrinfo")) return `DNS lookup failed — could not resolve hostname. (${msg})`;
  if (msg.includes("ETIMEDOUT") || msg.includes("timeout")) return `Request timed out. (${msg})`;
  if (msg.includes("certificate") || msg.includes("SSL")) return `SSL/TLS error. (${msg})`;
  return msg;
}

// ── Create a fresh MCP server instance (one per session for HTTP) ────────

export function createServer(): { server: McpServer; state: SessionState } {
  const state: SessionState = {
    collection: null,
    endpoints: [],
    sourceUrl: null,
  };

  const server = new McpServer({
    name: "dockly-mcp",
    version: "1.0.0",
  });

  // ── Tool: load_api_docs ────────────────────────────────────────────────

  server.tool(
    "load_api_docs",
    "Load API documentation from a URL. Supports Postman Collection JSON, OpenAPI 3.x JSON/YAML, and Postman Documenter URLs.",
    {
      url: z.string().describe("URL to the API documentation (Postman collection JSON URL, OpenAPI spec URL, Postman Documenter URL, raw GitHub URL, etc.)"),
    },
    async ({ url }) => {
      try {
        // Issue 2.1: Detect Postman Documenter URLs
        const documenterInfo = parseDocumenterUrl(url);
        let text: string;
        let contentType: string;

        if (documenterInfo) {
          // Fetch collection JSON via Postman's gateway API
          const gwUrl = `https://documenter.gw.postman.com/api/collections/${documenterInfo.userId}/${documenterInfo.slug}?segregateAuth=true&versionTag=latest`;
          try {
            const gwResponse = await fetch(gwUrl, {
              headers: { Accept: "application/json" },
            });
            if (gwResponse.ok) {
              text = await gwResponse.text();
              contentType = gwResponse.headers.get("content-type") ?? "application/json";
            } else {
              return {
                content: [{
                  type: "text",
                  text: [
                    `Could not fetch collection from Postman Documenter URL (status ${gwResponse.status}).`,
                    ``,
                    gwResponse.status === 404
                      ? `The collection may not exist, may have been deleted, or may be private.`
                      : `Postman's API returned an unexpected error.`,
                    ``,
                    `**Workaround:** Export the collection as JSON from Postman and use \`load_api_docs_from_text\` (with file_path) instead.`,
                  ].join("\n"),
                }],
              };
            }
          } catch (fetchErr) {
            return {
              content: [{
                type: "text",
                text: `Could not fetch collection from Postman Documenter URL: ${describeFetchError(fetchErr)}\n\n**Workaround:** Export the collection as JSON and use \`load_api_docs_from_text\` (with file_path) instead.`,
              }],
            };
          }
        } else {
          const response = await fetch(url, {
            headers: { Accept: "application/json, application/x-yaml, text/yaml, text/plain, */*" },
          });

          if (!response.ok) {
            return { content: [{ type: "text", text: `Failed to fetch: ${response.status} ${response.statusText}` }] };
          }

          text = await response.text();
          contentType = response.headers.get("content-type") ?? "";
        }

        const collection = parseContent(text, contentType);
        if (!collection) {
          // Issue 3.4: Better error messages
          const isHtml = text.trimStart().startsWith("<!") || text.trimStart().startsWith("<html");
          const preview = text.slice(0, 200).replace(/\n/g, " ");
          let reason = "Unrecognized format.";
          if (isHtml) {
            reason = "Received HTML instead of JSON/YAML — this URL may be a web page rather than a raw API spec. Try finding the raw JSON/YAML URL.";
          } else {
            try { JSON.parse(text); reason = "Valid JSON but not a recognized Postman Collection or OpenAPI spec. Check that the JSON has 'info'+'item' (Postman) or 'openapi'+'paths' (OpenAPI)."; } catch { reason = "Content is not valid JSON or YAML."; }
          }
          return {
            content: [{
              type: "text",
              text: `Could not parse the document.\n\n**Reason:** ${reason}\n**Content preview:** \`${preview}...\`\n\nSupported formats: Postman Collection v2.1, OpenAPI 3.x (JSON/YAML).`,
            }],
          };
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
        return { content: [{ type: "text", text: `Error loading docs: ${describeFetchError(err)}` }] };
      }
    }
  );

  // ── Tool: load_api_docs_from_text ──────────────────────────────────────

  server.tool(
    "load_api_docs_from_text",
    "Load API documentation from raw text content or a local file path.",
    {
      content: z.string().optional().describe("Raw Postman Collection JSON or OpenAPI 3.x JSON/YAML content"),
      file_path: z.string().optional().describe("Path to a local JSON/YAML file containing the API docs"),
      format: z.enum(["json", "yaml"]).default("json").describe("Format of the content"),
    },
    async ({ content, file_path, format }) => {
      // Issue 2.2: Support file_path parameter
      let rawContent: string;

      if (file_path) {
        try {
          rawContent = await readFile(file_path, "utf-8");
        } catch (err) {
          return {
            content: [{
              type: "text",
              text: `Could not read file: ${err instanceof Error ? err.message : String(err)}`,
            }],
          };
        }
      } else if (content) {
        rawContent = content;
      } else {
        return {
          content: [{
            type: "text",
            text: "Provide either `content` (raw JSON/YAML string) or `file_path` (path to a local file).",
          }],
        };
      }

      const collection = parseContent(rawContent, format === "yaml" ? "application/yaml" : "application/json");
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
      // Issue 3.2: Also search individual folder path segments
      const matches = state.endpoints.filter(
        (e) =>
          e.name.toLowerCase().includes(q) ||
          e.url.toLowerCase().includes(q) ||
          e.folder.toLowerCase().includes(q) ||
          e.id.toLowerCase().includes(q) ||
          (e.description?.toLowerCase().includes(q) ?? false)
      );

      if (matches.length === 0) {
        return { content: [{ type: "text", text: `No endpoints matching "${query}".` }] };
      }

      const lines = matches.map(
        (e) => `[${e.method.padEnd(7)}] ${e.url}  —  ${e.name}  (${e.folder})`
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

      // Issue 3.3: Show query params extracted from URL
      if (match.queryParams && match.queryParams.length > 0) {
        sections.push("", "**Query Parameters:**");
        for (const qp of match.queryParams) {
          const desc = qp.description ? `: ${qp.description}` : "";
          const val = qp.value ? ` = \`${qp.value}\`` : "";
          sections.push(`  - \`${qp.key}\`${val}${desc}`);
        }
      }

      if (match.body) {
        sections.push("", "**Request Body:**", "```json", match.body, "```");
      } else if (match.bodyObj?.mode === "formdata" && match.bodyObj.formdata) {
        sections.push("", "**Request Body (form-data):**");
        for (const f of match.bodyObj.formdata) {
          const type = f.type === "file" ? " [file]" : "";
          sections.push(`  - \`${f.key}\`${type}: ${f.value || f.src || "(empty)"}`);
        }
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

      const authInfo = state.collection.auth
        ? `Auth: ${state.collection.auth.type} (collection-level)`
        : "";

      return {
        content: [{
          type: "text",
          text: [
            `Name: ${state.collection.info.name}`,
            state.collection.info.description ? `Description: ${state.collection.info.description}` : "",
            state.sourceUrl ? `Source: ${state.sourceUrl}` : "",
            authInfo,
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
      // Resolve collection variables first
      if (state.collection.variable.length > 0) {
        url = resolveVariables(url, state.collection.variable);
      }
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
      // Add collection-level auth header
      if (state.collection.auth?.type === "bearer" && state.collection.auth.bearer) {
        const tokenEntry = state.collection.auth.bearer.find((b) => b.key === "token");
        if (tokenEntry) {
          const tokenValue = resolveVariables(tokenEntry.value, state.collection.variable);
          reqHeaders["Authorization"] = `Bearer ${tokenValue}`;
        }
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
        // Issue 3.4: Better error messages
        return {
          content: [{
            type: "text",
            text: `Request failed after ${elapsed}ms: ${describeFetchError(err)}`,
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

      const variables = state.collection.variable ?? [];

      let url = match.url;
      // Issue 2.6: Resolve {{variables}} from collection variables
      if (variables.length > 0) {
        url = resolveVariables(url, variables);
      }
      url = url.replace(/\{\{baseUrl\}\}/g, base_url ?? "{{baseUrl}}");

      if (!url.startsWith("http") && base_url) {
        url = base_url.replace(/\/$/, "") + "/" + url.replace(/^\//, "");
      }

      const parts = [`curl -X ${match.method} '${url}'`];

      // Existing endpoint headers
      for (const h of match.headers) {
        let headerValue = h.value;
        if (variables.length > 0) headerValue = resolveVariables(headerValue, variables);
        parts.push(`  -H '${h.key}: ${headerValue}'`);
      }

      // Issue 2.4: Include collection-level auth header
      const hasAuthHeader = match.headers.some((h) => h.key.toLowerCase() === "authorization");
      if (!hasAuthHeader && state.collection.auth?.type === "bearer" && state.collection.auth.bearer) {
        const tokenEntry = state.collection.auth.bearer.find((b) => b.key === "token");
        if (tokenEntry) {
          let tokenValue = tokenEntry.value;
          if (variables.length > 0) tokenValue = resolveVariables(tokenValue, variables);
          parts.push(`  -H 'Authorization: Bearer ${tokenValue}'`);
        }
      }

      // Issue 2.4: Handle formdata bodies
      if (match.bodyObj?.mode === "formdata" && match.bodyObj.formdata) {
        for (const field of match.bodyObj.formdata) {
          if (field.type === "file") {
            parts.push(`  -F '${field.key}=@${field.src || "/path/to/file"}'`);
          } else {
            let val = field.value ?? "";
            if (variables.length > 0) val = resolveVariables(val, variables);
            parts.push(`  -F '${field.key}=${val}'`);
          }
        }
      } else if (match.body && !["GET", "HEAD"].includes(match.method)) {
        let bodyStr = match.body;
        // Issue 2.6: Resolve variables in body
        if (variables.length > 0) bodyStr = resolveVariables(bodyStr, variables);
        parts.push(`  -d '${bodyStr.replace(/'/g, "'\\''")}'`);
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
    "Get the request body schema (inferred from example) for a specific endpoint.",
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

      // Handle formdata bodies
      if (match.bodyObj?.mode === "formdata" && match.bodyObj.formdata) {
        const lines = [
          `## Request Body Schema: ${match.method} ${match.name}`,
          "",
          "**Content-Type:** multipart/form-data",
          "",
          "| Field | Type | Value |",
          "|-------|------|-------|",
        ];
        for (const f of match.bodyObj.formdata) {
          const type = f.type === "file" ? "file" : "text";
          lines.push(`| ${f.key} | ${type} | ${f.value || f.src || ""} |`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      if (!match.body) {
        return { content: [{ type: "text", text: `${match.method} ${match.name} has no request body.` }] };
      }

      // Issue 2.5: Infer schema types from example JSON
      const sections = [
        `## Request Body Schema: ${match.method} ${match.name}`,
      ];

      try {
        const parsed = JSON.parse(match.body);
        const schemaLines = inferSchema(parsed);

        if (schemaLines.length > 0) {
          sections.push(
            "",
            "**Inferred Schema:**",
            "",
            "| Field | Type | Required | Example |",
            "|-------|------|----------|---------|",
            ...schemaLines,
          );
        }
      } catch {
        // Not valid JSON, just show raw
      }

      sections.push("", "**Example:**", "", "```json", match.body, "```");

      return {
        content: [{ type: "text", text: sections.join("\n") }],
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

      // Issue 2.3: Better messaging when responses are empty
      if (match.responses.length === 0) {
        const hasAnyResponses = state.endpoints.some((e) => e.responses.length > 0);
        if (!hasAnyResponses) {
          return {
            content: [{
              type: "text",
              text: [
                `${match.method} ${match.name} has no response examples.`,
                "",
                "**Note:** No endpoints in this collection have response examples. Response data may have been stripped when loading the collection (e.g., to reduce size for `load_api_docs_from_text`). Try reloading the full collection with `load_api_docs` or `load_api_docs_from_text` with `file_path` to include responses.",
              ].join("\n"),
            }],
          };
        }
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

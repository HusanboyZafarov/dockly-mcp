import yaml from "js-yaml";
import type {
  OpenApiSpec,
  OpenApiSchema,
  OpenApiParameter,
  PostmanCollection,
  PostmanFolder,
  PostmanRequestItem,
  PostmanHeader,
  PostmanBody,
  PostmanResponse,
  PostmanRequestDetail,
  FlatEndpoint,
} from "./types.js";
import { isOpenApiSpec, isRequestItem } from "./types.js";

// ── $ref resolution ──────────────────────────────────────────────────────

function resolveRef(spec: OpenApiSpec, ref: string): OpenApiSchema | null {
  const parts = ref.replace(/^#\//, "").split("/");
  let current: unknown = spec;
  for (const part of parts) {
    if (current && typeof current === "object") {
      current = (current as Record<string, unknown>)[part];
    } else {
      return null;
    }
  }
  return current as OpenApiSchema;
}

function resolveSchema(
  spec: OpenApiSpec,
  schema: OpenApiSchema,
  visited = new Set<string>(),
  depth = 0
): OpenApiSchema {
  if (depth > 6) return schema;

  if (schema.$ref) {
    if (visited.has(schema.$ref))
      return { type: "object", description: `(circular: ${schema.$ref})` };
    const resolved = resolveRef(spec, schema.$ref);
    if (!resolved) return schema;
    const nextVisited = new Set(visited);
    nextVisited.add(schema.$ref);
    return resolveSchema(spec, resolved, nextVisited, depth + 1);
  }

  for (const key of ["allOf", "oneOf", "anyOf"] as const) {
    if (schema[key]?.length) {
      const merged: OpenApiSchema = { ...schema };
      delete merged.allOf;
      delete merged.oneOf;
      delete merged.anyOf;
      for (const sub of schema[key]!) {
        const resolved = resolveSchema(spec, sub, visited, depth + 1);
        if (resolved.properties) {
          merged.properties = { ...merged.properties, ...resolved.properties };
        }
        if (resolved.type && !merged.type) merged.type = resolved.type;
      }
      return merged;
    }
  }

  if (schema.properties) {
    const resolvedProps: Record<string, OpenApiSchema> = {};
    for (const [key, prop] of Object.entries(schema.properties)) {
      resolvedProps[key] = resolveSchema(spec, prop, visited, depth + 1);
    }
    return { ...schema, properties: resolvedProps };
  }

  if (schema.items) {
    return {
      ...schema,
      items: resolveSchema(spec, schema.items, visited, depth + 1),
    };
  }

  return schema;
}

// ── Schema to example ────────────────────────────────────────────────────

function schemaToExample(schema: OpenApiSchema): unknown {
  if (schema.example !== undefined) return schema.example;
  if (schema.enum?.length) return schema.enum[0];

  switch (schema.type) {
    case "object": {
      if (!schema.properties) return {};
      const obj: Record<string, unknown> = {};
      for (const [key, prop] of Object.entries(schema.properties)) {
        if (prop.readOnly) continue;
        obj[key] = schemaToExample(prop);
      }
      return obj;
    }
    case "array":
      return schema.items ? [schemaToExample(schema.items)] : [];
    case "string":
      return schema.format === "date-time"
        ? "2024-01-01T00:00:00Z"
        : schema.format === "date"
          ? "2024-01-01"
          : schema.format === "uri"
            ? "https://example.com"
            : "string";
    case "integer":
    case "number":
      return 0;
    case "boolean":
      return true;
    default:
      return null;
  }
}

// ── OpenAPI to Postman conversion ────────────────────────────────────────

const HTTP_METHODS = [
  "get", "post", "put", "patch", "delete", "head", "options",
] as const;

export function openApiToPostmanCollection(
  spec: OpenApiSpec
): PostmanCollection {
  const tagGroups: Record<string, PostmanRequestItem[]> = {};
  const tagOrder: string[] = [];

  const hasSecurity =
    !!spec.components?.securitySchemes &&
    Object.keys(spec.components.securitySchemes).length > 0;

  const baseUrl = spec.servers?.[0]?.url ?? "";

  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation) continue;

      const tag = operation.tags?.[0] ?? "General";
      if (!tagGroups[tag]) {
        tagGroups[tag] = [];
        tagOrder.push(tag);
      }

      const name = operation.operationId ?? `${method.toUpperCase()} ${path}`;

      const headers: PostmanHeader[] = [];
      const opSecurity = operation.security ?? (hasSecurity ? [{}] : []);
      if (opSecurity.length > 0) {
        headers.push({ key: "Authorization", value: "Bearer {{token}}" });
      }
      headers.push({ key: "Content-Type", value: "application/json" });

      let body: PostmanBody | undefined;
      if (operation.requestBody?.content) {
        const jsonContent = operation.requestBody.content["application/json"];
        if (jsonContent?.schema) {
          const resolved = resolveSchema(spec, jsonContent.schema);
          const example = schemaToExample(resolved);
          body = {
            mode: "raw",
            raw: JSON.stringify(example, null, 2),
            options: { raw: { language: "json" } },
          };
        }
      }

      const responses: PostmanResponse[] = [];
      if (operation.responses) {
        for (const [statusCode, response] of Object.entries(operation.responses)) {
          const code = parseInt(statusCode, 10) || 0;
          let bodyStr = "";
          if (response.content?.["application/json"]?.schema) {
            const resolved = resolveSchema(
              spec,
              response.content["application/json"].schema
            );
            const example = schemaToExample(resolved);
            bodyStr = JSON.stringify(example, null, 2);
          }
          const statusText = response.description ?? statusCode;
          responses.push({
            name: `${statusCode} ${statusText}`,
            status: statusText,
            code,
            header: [],
            body: bodyStr,
          });
        }
      }

      const parameters = (operation.parameters as OpenApiParameter[] | undefined)?.map(
        (p) => ({
          name: p.name,
          in: p.in,
          required: p.required,
          description: p.description,
          schema: p.schema
            ? { type: (p.schema as { type?: string }).type, format: (p.schema as { format?: string }).format }
            : undefined,
        })
      );

      const fullPath = baseUrl + path;

      const requestDetail: PostmanRequestDetail = {
        method: method.toUpperCase() as PostmanRequestDetail["method"],
        header: headers,
        url: {
          raw: fullPath,
          host: [],
          path: fullPath.split("/").filter(Boolean),
        },
        body,
        description: operation.description ?? operation.summary,
        parameters,
      };

      tagGroups[tag].push({
        name,
        request: requestDetail,
        response: responses,
      });
    }
  }

  const folders: PostmanFolder[] = tagOrder.map((tag) => ({
    name: tag,
    item: tagGroups[tag],
  }));

  return {
    info: {
      _postman_id: `openapi-${Date.now()}`,
      name: spec.info.title,
      description: spec.info.description ?? "",
      schema: "openapi",
    },
    variable: [],
    item: folders,
  };
}

// ── Normalize Postman items ──────────────────────────────────────────────

function normalizePostmanItems(items: (PostmanFolder | PostmanRequestItem)[]) {
  for (const item of items) {
    if ("request" in item) {
      const req = item.request;
      const rawUrl = req.url as unknown;
      if (typeof rawUrl === "string") {
        (req as unknown as Record<string, unknown>).url = {
          raw: rawUrl,
          host: [],
          path: rawUrl.split("/").filter(Boolean),
        };
      }
      if (!item.response) {
        (item as unknown as Record<string, unknown>).response = [];
      }
    } else if ("item" in item && Array.isArray(item.item)) {
      normalizePostmanItems(item.item);
    }
  }
}

// ── Parse raw content ────────────────────────────────────────────────────

export function parseContent(
  content: string,
  contentType: string
): PostmanCollection | null {
  const isYaml =
    contentType.includes("yaml") ||
    contentType.includes("yml") ||
    content.trimStart().startsWith("openapi:");

  try {
    const data = isYaml ? yaml.load(content) : JSON.parse(content);

    if (isOpenApiSpec(data)) {
      return openApiToPostmanCollection(data);
    }

    if (
      data &&
      typeof data === "object" &&
      "info" in (data as object) &&
      "item" in (data as object)
    ) {
      normalizePostmanItems((data as PostmanCollection).item);
      return data as PostmanCollection;
    }

    return null;
  } catch {
    return null;
  }
}

// ── Flatten collection to searchable endpoints ───────────────────────────

export function flattenCollection(
  items: (PostmanFolder | PostmanRequestItem)[],
  folderPath: string[] = []
): FlatEndpoint[] {
  const result: FlatEndpoint[] = [];
  if (!items) return result;

  for (const item of items) {
    if (isRequestItem(item)) {
      const id = [...folderPath, item.name].join("/");
      result.push({
        id,
        folder: folderPath.join("/"),
        name: item.name,
        method: item.request.method,
        url: item.request.url.raw,
        description: item.request.description,
        headers: item.request.header,
        body: item.request.body?.raw,
        parameters: item.request.parameters,
        responses: item.response,
      });
    } else {
      const folder = item as PostmanFolder;
      result.push(
        ...flattenCollection(folder.item, [...folderPath, folder.name])
      );
    }
  }

  return result;
}

// ── Get folder tree ──────────────────────────────────────────────────────

export interface FolderTree {
  name: string;
  description?: string;
  endpointCount: number;
  subfolders: FolderTree[];
}

export function getFolderTree(
  items: (PostmanFolder | PostmanRequestItem)[]
): FolderTree[] {
  const result: FolderTree[] = [];

  for (const item of items) {
    if (!isRequestItem(item)) {
      const folder = item as PostmanFolder;
      const subfolders = getFolderTree(folder.item);
      const directEndpoints = folder.item.filter(isRequestItem).length;
      const subEndpoints = subfolders.reduce((sum, sf) => sum + sf.endpointCount, 0);

      result.push({
        name: folder.name,
        description: folder.description,
        endpointCount: directEndpoints + subEndpoints,
        subfolders,
      });
    }
  }

  return result;
}

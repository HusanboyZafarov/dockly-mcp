// ── Postman types ─────────────────────────────────────────────────────────

export interface PostmanAuth {
  type: string; // "bearer", "basic", "apikey", etc.
  bearer?: { key: string; value: string; type?: string }[];
  basic?: { key: string; value: string; type?: string }[];
  apikey?: { key: string; value: string; type?: string }[];
}

export interface PostmanCollection {
  info: PostmanInfo;
  variable: PostmanVariable[];
  auth?: PostmanAuth;
  item: (PostmanFolder | PostmanRequestItem)[];
}

export interface PostmanInfo {
  _postman_id: string;
  name: string;
  description: string;
  schema: string;
}

export interface PostmanVariable {
  key: string;
  value: string;
  type: string;
}

export interface PostmanFolder {
  name: string;
  description?: string;
  item: (PostmanFolder | PostmanRequestItem)[];
}

export interface PostmanRequestItem {
  name: string;
  request: PostmanRequestDetail;
  response: PostmanResponse[];
}

export interface PostmanRequestDetail {
  method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT" | "HEAD" | "OPTIONS";
  header: PostmanHeader[];
  url: PostmanUrl;
  body?: PostmanBody;
  description?: string;
  parameters?: ApiParameter[];
}

export interface PostmanUrl {
  raw: string;
  host: string[];
  path: string[];
}

export interface PostmanHeader {
  key: string;
  value: string;
}

export interface PostmanFormDataParam {
  key: string;
  value?: string;
  type?: string; // "text" | "file"
  src?: string;
  description?: string;
}

export interface PostmanBody {
  mode: string;
  raw?: string;
  formdata?: PostmanFormDataParam[];
  options?: { raw?: { language?: string } };
}

export interface PostmanResponse {
  name: string;
  status: string;
  code: number;
  header: PostmanHeader[];
  body: string;
}

export interface ApiParameter {
  name: string;
  in: "query" | "path" | "header" | "cookie";
  required?: boolean;
  description?: string;
  schema?: { type?: string; format?: string };
}

export function isRequestItem(
  item: PostmanFolder | PostmanRequestItem
): item is PostmanRequestItem {
  return "request" in item;
}

// ── OpenAPI types ─────────────────────────────────────────────────────────

export interface OpenApiSpec {
  openapi: string;
  info: {
    title: string;
    version: string;
    description?: string;
  };
  servers?: { url: string; description?: string }[];
  paths: Record<string, OpenApiPathItem>;
  components?: {
    schemas?: Record<string, OpenApiSchema>;
    securitySchemes?: Record<string, OpenApiSecurityScheme>;
  };
}

export interface OpenApiPathItem {
  get?: OpenApiOperation;
  post?: OpenApiOperation;
  put?: OpenApiOperation;
  patch?: OpenApiOperation;
  delete?: OpenApiOperation;
  head?: OpenApiOperation;
  options?: OpenApiOperation;
}

export interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: OpenApiParameter[];
  requestBody?: OpenApiRequestBody;
  responses?: Record<string, OpenApiResponse>;
  security?: Record<string, string[]>[];
}

export interface OpenApiParameter {
  name: string;
  in: "query" | "path" | "header" | "cookie";
  required?: boolean;
  description?: string;
  schema?: OpenApiSchema;
}

export interface OpenApiRequestBody {
  required?: boolean;
  content?: Record<string, { schema?: OpenApiSchema }>;
}

export interface OpenApiResponse {
  description?: string;
  content?: Record<string, { schema?: OpenApiSchema }>;
}

export interface OpenApiSchema {
  $ref?: string;
  type?: string;
  format?: string;
  properties?: Record<string, OpenApiSchema>;
  items?: OpenApiSchema;
  enum?: unknown[];
  required?: string[];
  description?: string;
  nullable?: boolean;
  readOnly?: boolean;
  allOf?: OpenApiSchema[];
  oneOf?: OpenApiSchema[];
  anyOf?: OpenApiSchema[];
  example?: unknown;
}

export interface OpenApiSecurityScheme {
  type: string;
  scheme?: string;
  bearerFormat?: string;
  name?: string;
  in?: string;
}

export function isOpenApiSpec(data: unknown): data is OpenApiSpec {
  return (
    typeof data === "object" &&
    data !== null &&
    "openapi" in data &&
    "paths" in data
  );
}

// ── Flat endpoint for search/listing ──────────────────────────────────────

export interface FlatEndpoint {
  id: string;
  folder: string;
  name: string;
  method: string;
  url: string;
  description?: string;
  headers: PostmanHeader[];
  body?: string;
  bodyObj?: PostmanBody;
  parameters?: ApiParameter[];
  queryParams?: { key: string; value: string; description?: string }[];
  responses: PostmanResponse[];
}

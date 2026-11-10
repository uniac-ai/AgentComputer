// Everything derived from openapi.yaml: the types the SDK and the handlers use, and the table the
// HTTP router and the MCP control tools are driven by. The output is checked in, and CI fails if
// running this changes it.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { parse } from "yaml";

const OUT = "src/generated";
const spec = parse(readFileSync("openapi.yaml", "utf8"));

// By npx, because it needs TypeScript 5 beside it and this project builds with 7.
execFileSync(
  "npx",
  [
    "--yes",
    "-p",
    "openapi-typescript@7.13.0",
    "-p",
    "typescript@5.9.3",
    "openapi-typescript",
    "openapi.yaml",
    "-o",
    `${OUT}/schema.d.ts`,
  ],
  { stdio: ["ignore", "ignore", "inherit"] },
);

/** A copy with every `$ref` replaced by what it names. */
function inlined(value) {
  if (Array.isArray(value)) return value.map(inlined);
  if (typeof value !== "object" || value === null) return value;
  if (typeof value.$ref === "string") {
    const target = value.$ref
      .slice(2)
      .split("/")
      .reduce((at, key) => at[key], spec);
    return inlined(target);
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, inlined(item)]));
}

const METHODS = ["get", "post", "delete", "patch", "put"];
const operations = [];
for (const [path, item] of Object.entries(spec.paths)) {
  for (const method of METHODS) {
    const operation = item[method];
    if (!operation) continue;
    const parameters = inlined([...(item.parameters ?? []), ...(operation.parameters ?? [])]);
    const body = inlined(operation.requestBody?.content?.["application/json"]?.schema);
    const properties = {
      ...Object.fromEntries(parameters.map((p) => [p.name, p.schema])),
      ...(body?.properties ?? {}),
    };
    const required = [
      ...parameters.filter((p) => p.required).map((p) => p.name),
      ...(operation.requestBody?.required ? (body?.required ?? []) : []),
    ];
    const status = Object.keys(operation.responses).find((code) => /^[12]/.test(code));
    operations.push({
      operationId: operation.operationId,
      method: method.toUpperCase(),
      path,
      tool: operation["x-mcp-tool"],
      summary: operation.summary,
      status: Number(status),
      hasBody: Boolean(operation.requestBody),
      pathParameters: parameters.filter((p) => p.in === "path").map((p) => p.name),
      queryParameters: parameters.filter((p) => p.in === "query").map((p) => p.name),
      input: { type: "object", additionalProperties: false, properties, required },
      output: inlined(operation.responses[status].content?.["application/json"]?.schema) ?? null,
      websocket: status === "101",
    });
  }
}

writeFileSync(
  `${OUT}/operations.ts`,
  `// Generated from openapi.yaml by scripts/generate.js. Don't edit.
export const OPENAPI = ${JSON.stringify(spec, null, 2)} as const;

export interface Operation {
  operationId: string;
  method: string;
  path: string;
  /** Absent where the operation isn't a tool, as a WebSocket isn't. */
  tool?: string;
  summary: string;
  status: number;
  hasBody: boolean;
  pathParameters: string[];
  queryParameters: string[];
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  websocket: boolean;
}

export const OPERATIONS: Operation[] = ${JSON.stringify(operations, null, 2)};
`,
);
console.log(`Generated ${operations.length} operations.`);

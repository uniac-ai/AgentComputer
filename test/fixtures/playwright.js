// Stands in for Playwright MCP: serves its tools over HTTP on a port of its own and says so.
import { createServer } from "node:http";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { McpServer } from "@modelcontextprotocol/server";

const server = createServer(async (request, response) => {
  const mcp = new McpServer({ name: "playwright-stand-in", version: "0" });
  for (const name of ["browser_navigate", "browser_snapshot", "browser_run_code_unsafe"])
    mcp.registerTool(name, { description: `Stands in for ${name}.` }, () => ({
      content: [{ type: "text", text: `${name} in ${process.cwd()}` }],
    }));
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await mcp.connect(transport);
  await transport.handleRequest(request, response);
});
server.listen(0, "127.0.0.1", () => {
  console.log(`Listening on http://127.0.0.1:${server.address().port}`);
});

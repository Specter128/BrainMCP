import { randomUUID } from "node:crypto";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export async function startTransport(options: any) {
  const app = createMcpExpressApp({ host: "0.0.0.0" });

  app.get("/healthz", (req, res) => res.json({ ok: true }));

  app.all("/mcp", async (req, res) => {
    const server = options.createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID()
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.listen(options.port, "0.0.0.0");
  options.logger.info(`Server listening on port ${options.port}`);
}

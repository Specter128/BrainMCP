import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerHealthTool } from "./health.js";
import { registerSessionTools } from "./sessionTools.js";

export function createReasoningOrchestratorServer(context: any): McpServer {
  const server = new McpServer({
    name: "reasoning-orchestrator",
    version: context.version
  });

  registerHealthTool(server, context);
  registerSessionTools(server, context);

  return server;
}

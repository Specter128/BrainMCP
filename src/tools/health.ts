import { z } from "zod";

export function registerHealthTool(server: any, context: any) {
  server.registerTool(
    "health",
    { description: "Check server health", inputSchema: z.object({}) },
    async () => ({ content: [{ type: "text", text: JSON.stringify({ ok: true, version: context.version }) }] })
  );
}

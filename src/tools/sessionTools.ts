import { z } from "zod";
import { randomUUID } from "node:crypto";

export function registerSessionTools(server: any, context: any) {
  server.registerTool(
    "create_session",
    {
      description: "Create a session",
      inputSchema: z.object({ title: z.string().optional() })
    },
    async (args: any) => {
      const sessionId = randomUUID();
      const session = context.repositories.sessions.create({ sessionId, title: args.title });
      return { content: [{ type: "text", text: JSON.stringify(session) }] };
    }
  );
}

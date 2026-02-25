import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const EnvSchema = z.object({
  MCP_PORT: z.coerce.number().default(8080),
  MCP_AUTH_TOKEN: z.string().min(12),
  MCP_DATA_DIR: z.string().default("/srv/mcp-reasoning/data"),
  MCP_LOG_LEVEL: z.enum(["info", "debug", "error"]).default("info")
});

export function loadConfig() {
  const parsed = EnvSchema.parse(process.env);
  fs.mkdirSync(parsed.MCP_DATA_DIR, { recursive: true });
  return {
    ...parsed,
    dbPath: path.join(parsed.MCP_DATA_DIR, "reasoning.sqlite")
  };
}

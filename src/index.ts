import { createDatabase } from "./storage/db.js";
import { createRepositories } from "./storage/repositories/index.js";
import { loadConfig } from "./server/config.js";
import { createLogger } from "./server/logger.js";
import { startTransport } from "./server/transport.js";
import { createReasoningOrchestratorServer } from "./tools/index.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const db = createDatabase({ dbPath: config.dbPath });
  const repositories = createRepositories(db);

  await startTransport({
    port: config.port,
    authToken: config.authToken,
    logger,
    createServer: () =>
      createReasoningOrchestratorServer({
        version: "1.0.0",
        startedAtMs: Date.now(),
        repositories
      })
  });
}

void main().catch(console.error);

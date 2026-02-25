import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDatabase } from "../../src/storage/db.js";
import { createRepositories } from "../../src/storage/repositories/index.js";

export function createTempDb(): {
  db: ReturnType<typeof createDatabase>;
  repositories: ReturnType<typeof createRepositories>;
  cleanup: () => void;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reasoning-orchestrator-test-"));
  const db = createDatabase({
    dbPath: path.join(dir, "test.sqlite"),
    migrationsDir: path.resolve(process.cwd(), "src/storage/migrations")
  });
  const repositories = createRepositories(db);

  return {
    db,
    repositories,
    cleanup: () => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export function createDatabase(options: { dbPath: string }) {
  const db = new Database(options.dbPath);
  const migration = fs.readFileSync("src/storage/migrations/001_init.sql", "utf8");
  db.exec(migration);
  return db;
}

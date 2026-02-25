import { SessionsRepository } from "./sessions.js";

export function createRepositories(db: any) {
  return {
    sessions: new SessionsRepository(db)
  };
}

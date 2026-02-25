export class SessionsRepository {
  constructor(private db: any) {}
  create(input: any) {
    this.db.prepare("INSERT INTO sessions (sessionId, title, createdAt) VALUES (?, ?, ?)")
      .run(input.sessionId, input.title, new Date().toISOString());
    return input;
  }
  getById(id: string) {
    return this.db.prepare("SELECT * FROM sessions WHERE sessionId = ?").get(id);
  }
}

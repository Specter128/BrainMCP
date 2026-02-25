CREATE TABLE IF NOT EXISTS sessions (
  sessionId TEXT PRIMARY KEY,
  title TEXT,
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decision_logs (
  id TEXT PRIMARY KEY,
  sessionId TEXT NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  FOREIGN KEY(sessionId) REFERENCES sessions(sessionId)
);

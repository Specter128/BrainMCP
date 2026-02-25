import type Database from "better-sqlite3";
import { nowIso } from "../../utils/time.js";

export type DecisionLogKind =
  | "decision"
  | "observation"
  | "risk"
  | "checkpoint"
  | "result"
  | "note";

export type DecisionLogImportance = "low" | "medium" | "high";

export type DecisionLogRecord = {
  id: string;
  sessionId: string;
  kind: DecisionLogKind;
  summary: string;
  details?: {
    rationale?: string;
    evidence?: string[];
    impact?: string;
    relatedStepIds?: string[];
    relatedAssumptionIds?: string[];
  };
  importance: DecisionLogImportance;
  timestamp: string;
};

type DecisionRow = {
  id: string;
  sessionId: string;
  kind: DecisionLogKind;
  summary: string;
  detailsJson: string | null;
  importance: DecisionLogImportance;
  timestamp: string;
};

export class DecisionLogsRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: {
    id: string;
    sessionId: string;
    kind: DecisionLogKind;
    summary: string;
    details?: DecisionLogRecord["details"];
    importance?: DecisionLogImportance;
    timestamp?: string;
  }): DecisionLogRecord {
    const timestamp = input.timestamp ?? nowIso();
    this.db
      .prepare(
        `INSERT INTO decision_logs(id, sessionId, kind, summary, detailsJson, importance, timestamp)
         VALUES (@id, @sessionId, @kind, @summary, @detailsJson, @importance, @timestamp)`
      )
      .run({
        id: input.id,
        sessionId: input.sessionId,
        kind: input.kind,
        summary: input.summary,
        detailsJson: input.details ? JSON.stringify(input.details) : null,
        importance: input.importance ?? "medium",
        timestamp
      });

    const created = this.db
      .prepare("SELECT * FROM decision_logs WHERE id = ?")
      .get(input.id) as DecisionRow | undefined;
    if (!created) {
      throw new Error(`Failed to create decision log entry ${input.id}`);
    }
    return mapDecisionRow(created);
  }

  list(params: {
    sessionId: string;
    limit: number;
    kinds?: DecisionLogKind[];
    since?: string;
  }): DecisionLogRecord[] {
    const clauses = ["sessionId = @sessionId"];
    const bind: Record<string, unknown> = {
      sessionId: params.sessionId,
      limit: params.limit
    };

    if (params.since) {
      clauses.push("timestamp >= @since");
      bind.since = params.since;
    }
    if (params.kinds?.length) {
      const placeholders = params.kinds.map((_, idx) => `@kind${idx}`);
      params.kinds.forEach((kind, idx) => {
        bind[`kind${idx}`] = kind;
      });
      clauses.push(`kind IN (${placeholders.join(",")})`);
    }

    const sql = `
      SELECT * FROM decision_logs
      WHERE ${clauses.join(" AND ")}
      ORDER BY timestamp DESC
      LIMIT @limit`;

    return (this.db.prepare(sql).all(bind) as DecisionRow[]).map(mapDecisionRow);
  }

  countBySession(sessionId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(1) as count FROM decision_logs WHERE sessionId = ?")
      .get(sessionId) as { count: number };
    return row.count;
  }

  countRisks(sessionId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(1) as count FROM decision_logs WHERE sessionId = ? AND kind = 'risk'")
      .get(sessionId) as { count: number };
    return row.count;
  }
}

function mapDecisionRow(row: DecisionRow): DecisionLogRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    kind: row.kind,
    summary: row.summary,
    details: row.detailsJson
      ? (JSON.parse(row.detailsJson) as DecisionLogRecord["details"])
      : undefined,
    importance: row.importance,
    timestamp: row.timestamp
  };
}

import type Database from "better-sqlite3";
import { nowIso } from "../../utils/time.js";

export type AssumptionType = "explicit" | "implicit";
export type AssumptionCategory =
  | "technical"
  | "environment"
  | "data"
  | "dependency"
  | "process"
  | "user-intent";
export type AssumptionStatus = "verified" | "unverified" | "risky" | "contradicted";
export type AssumptionRisk = "low" | "medium" | "high";
export type AssumptionConfidence = "low" | "medium" | "high";

export type AssumptionRecord = {
  assumptionId: string;
  sessionId: string;
  text: string;
  normalizedHash: string;
  type: AssumptionType;
  category: AssumptionCategory;
  status: AssumptionStatus;
  risk: AssumptionRisk;
  evidenceNeeded?: string[];
  confidence?: AssumptionConfidence;
  updatedAt: string;
};

type AssumptionRow = {
  assumptionId: string;
  sessionId: string;
  text: string;
  normalizedHash: string;
  type: AssumptionType;
  category: AssumptionCategory;
  status: AssumptionStatus;
  risk: AssumptionRisk;
  evidenceNeededJson: string | null;
  confidence: AssumptionConfidence | null;
  updatedAt: string;
};

export class AssumptionsRepository {
  constructor(private readonly db: Database.Database) {}

  upsertMany(
    assumptions: Array<
      Omit<AssumptionRecord, "updatedAt" | "status" | "confidence" | "evidenceNeeded"> & {
        status?: AssumptionStatus;
        confidence?: AssumptionConfidence;
        evidenceNeeded?: string[];
      }
    >
  ): AssumptionRecord[] {
    if (assumptions.length === 0) {
      return [];
    }
    const timestamp = nowIso();
    const statement = this.db.prepare(
      `INSERT INTO assumptions(
        assumptionId, sessionId, text, normalizedHash, type, category, status, risk, evidenceNeededJson, confidence, updatedAt
      ) VALUES (
        @assumptionId, @sessionId, @text, @normalizedHash, @type, @category, @status, @risk, @evidenceNeededJson, @confidence, @updatedAt
      )
      ON CONFLICT(sessionId, normalizedHash) DO UPDATE SET
        text = excluded.text,
        type = excluded.type,
        category = excluded.category,
        status = excluded.status,
        risk = excluded.risk,
        evidenceNeededJson = excluded.evidenceNeededJson,
        confidence = excluded.confidence,
        updatedAt = excluded.updatedAt`
    );
    const select = this.db.prepare(
      "SELECT * FROM assumptions WHERE sessionId = ? AND normalizedHash = ?"
    );

    const records: AssumptionRecord[] = [];
    const tx = this.db.transaction(() => {
      for (const assumption of assumptions) {
        statement.run({
          assumptionId: assumption.assumptionId,
          sessionId: assumption.sessionId,
          text: assumption.text,
          normalizedHash: assumption.normalizedHash,
          type: assumption.type,
          category: assumption.category,
          status: assumption.status ?? "unverified",
          risk: assumption.risk,
          evidenceNeededJson: assumption.evidenceNeeded
            ? JSON.stringify(assumption.evidenceNeeded)
            : null,
          confidence: assumption.confidence ?? null,
          updatedAt: timestamp
        });

        const row = select.get(assumption.sessionId, assumption.normalizedHash) as
          | AssumptionRow
          | undefined;
        if (row) {
          records.push(mapAssumptionRow(row));
        }
      }
    });
    tx();
    return records;
  }

  listBySession(sessionId: string): AssumptionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM assumptions
         WHERE sessionId = ?
         ORDER BY updatedAt DESC`
      )
      .all(sessionId) as AssumptionRow[];
    return rows.map(mapAssumptionRow);
  }

  getById(assumptionId: string): AssumptionRecord | null {
    const row = this.db
      .prepare("SELECT * FROM assumptions WHERE assumptionId = ?")
      .get(assumptionId) as AssumptionRow | undefined;
    return row ? mapAssumptionRow(row) : null;
  }

  updateStatuses(
    sessionId: string,
    updates: Array<{
      assumptionId?: string;
      normalizedHash?: string;
      status: AssumptionStatus;
      confidence: AssumptionConfidence;
      evidenceNeeded: string[];
    }>
  ): number {
    if (updates.length === 0) {
      return 0;
    }
    let changed = 0;
    const timestamp = nowIso();
    const byIdStatement = this.db.prepare(
      `UPDATE assumptions
       SET status = @status, confidence = @confidence, evidenceNeededJson = @evidenceNeededJson, updatedAt = @updatedAt
       WHERE sessionId = @sessionId AND assumptionId = @assumptionId`
    );
    const byHashStatement = this.db.prepare(
      `UPDATE assumptions
       SET status = @status, confidence = @confidence, evidenceNeededJson = @evidenceNeededJson, updatedAt = @updatedAt
       WHERE sessionId = @sessionId AND normalizedHash = @normalizedHash`
    );
    const tx = this.db.transaction(() => {
      for (const update of updates) {
        const base = {
          sessionId,
          status: update.status,
          confidence: update.confidence,
          evidenceNeededJson: JSON.stringify(update.evidenceNeeded),
          updatedAt: timestamp
        };
        const result = update.assumptionId
          ? byIdStatement.run({ ...base, assumptionId: update.assumptionId })
          : byHashStatement.run({ ...base, normalizedHash: update.normalizedHash });
        changed += result.changes;
      }
    });
    tx();
    return changed;
  }

  countBySession(sessionId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(1) as count FROM assumptions WHERE sessionId = ?")
      .get(sessionId) as { count: number };
    return row.count;
  }

  countOpenRiskAssumptions(sessionId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(1) as count
         FROM assumptions
         WHERE sessionId = ?
           AND (status IN ('risky', 'contradicted') OR (status = 'unverified' AND risk = 'high'))`
      )
      .get(sessionId) as { count: number };
    return row.count;
  }
}

function mapAssumptionRow(row: AssumptionRow): AssumptionRecord {
  return {
    assumptionId: row.assumptionId,
    sessionId: row.sessionId,
    text: row.text,
    normalizedHash: row.normalizedHash,
    type: row.type,
    category: row.category,
    status: row.status,
    risk: row.risk,
    evidenceNeeded: row.evidenceNeededJson
      ? (JSON.parse(row.evidenceNeededJson) as string[])
      : undefined,
    confidence: row.confidence ?? undefined,
    updatedAt: row.updatedAt
  };
}

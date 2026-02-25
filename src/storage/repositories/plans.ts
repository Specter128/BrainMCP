import type Database from "better-sqlite3";
import { nowIso } from "../../utils/time.js";

export type PlanStrategy = "minimum-risk" | "fastest" | "balanced";

export type VerificationType =
  | "logic-check"
  | "evidence-check"
  | "test-check"
  | "review-check"
  | "manual-check";

export type PlanStepStatus = "pending" | "in_progress" | "blocked" | "done" | "skipped";

export type PlanStepVerification = {
  required: boolean;
  type: VerificationType;
  hint: string;
};

export type PlanRecord = {
  id: string;
  sessionId: string;
  goal: string;
  strategy: PlanStrategy;
  createdAt: string;
  updatedAt: string;
};

export type PlanStepRecord = {
  stepId: string;
  planId: string;
  sessionId: string;
  orderIndex: number;
  title: string;
  objective: string;
  dependsOn: string[];
  status: PlanStepStatus;
  verification: PlanStepVerification;
  risk: "low" | "medium" | "high";
  note?: string;
  updatedAt: string;
};

type PlanRow = {
  id: string;
  sessionId: string;
  goal: string;
  strategy: PlanStrategy;
  createdAt: string;
  updatedAt: string;
};

type PlanStepRow = {
  stepId: string;
  planId: string;
  sessionId: string;
  orderIndex: number;
  title: string;
  objective: string;
  dependsOnJson: string;
  status: PlanStepStatus;
  verificationJson: string;
  risk: "low" | "medium" | "high";
  note: string | null;
  updatedAt: string;
};

export class PlansRepository {
  constructor(private readonly db: Database.Database) {}

  createPlanWithSteps(input: {
    planId: string;
    sessionId: string;
    goal: string;
    strategy: PlanStrategy;
    steps: Omit<PlanStepRecord, "sessionId" | "planId" | "updatedAt">[];
  }): { plan: PlanRecord; steps: PlanStepRecord[] } {
    const timestamp = nowIso();
    const insert = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO plans(id, sessionId, goal, strategy, createdAt, updatedAt)
           VALUES (@id, @sessionId, @goal, @strategy, @createdAt, @updatedAt)`
        )
        .run({
          id: input.planId,
          sessionId: input.sessionId,
          goal: input.goal,
          strategy: input.strategy,
          createdAt: timestamp,
          updatedAt: timestamp
        });

      this.db.prepare("DELETE FROM plan_steps WHERE sessionId = ?").run(input.sessionId);

      const statement = this.db.prepare(
        `INSERT INTO plan_steps(stepId, planId, sessionId, orderIndex, title, objective, dependsOnJson, status, verificationJson, risk, note, updatedAt)
         VALUES (@stepId, @planId, @sessionId, @orderIndex, @title, @objective, @dependsOnJson, @status, @verificationJson, @risk, @note, @updatedAt)`
      );

      for (const step of input.steps) {
        statement.run({
          stepId: step.stepId,
          planId: input.planId,
          sessionId: input.sessionId,
          orderIndex: step.orderIndex,
          title: step.title,
          objective: step.objective,
          dependsOnJson: JSON.stringify(step.dependsOn),
          status: step.status,
          verificationJson: JSON.stringify(step.verification),
          risk: step.risk,
          note: step.note ?? null,
          updatedAt: timestamp
        });
      }
    });

    insert();
    const plan = this.getLatestPlan(input.sessionId);
    if (!plan) {
      throw new Error(`Plan creation failed for session ${input.sessionId}`);
    }
    return {
      plan,
      steps: this.listStepsBySession(input.sessionId)
    };
  }

  getLatestPlan(sessionId: string): PlanRecord | null {
    const row = this.db
      .prepare("SELECT * FROM plans WHERE sessionId = ? ORDER BY createdAt DESC LIMIT 1")
      .get(sessionId) as PlanRow | undefined;
    if (!row) {
      return null;
    }
    return mapPlanRow(row);
  }

  listStepsBySession(sessionId: string): PlanStepRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM plan_steps
         WHERE sessionId = ?
         ORDER BY orderIndex ASC`
      )
      .all(sessionId) as PlanStepRow[];
    return rows.map(mapStepRow);
  }

  updateStatuses(
    sessionId: string,
    updates: Array<{ stepId: string; status: PlanStepStatus; note?: string }>
  ): number {
    const statement = this.db.prepare(
      `UPDATE plan_steps
       SET status = @status, note = COALESCE(@note, note), updatedAt = @updatedAt
       WHERE sessionId = @sessionId AND stepId = @stepId`
    );
    let changed = 0;
    const timestamp = nowIso();
    const tx = this.db.transaction(() => {
      for (const update of updates) {
        const result = statement.run({
          sessionId,
          stepId: update.stepId,
          status: update.status,
          note: update.note ?? null,
          updatedAt: timestamp
        });
        changed += result.changes;
      }
    });
    tx();
    if (changed > 0) {
      this.db
        .prepare("UPDATE plans SET updatedAt = ? WHERE sessionId = ?")
        .run(timestamp, sessionId);
    }
    return changed;
  }

  getProgress(sessionId: string): Record<PlanStepStatus, number> {
    const rows = this.db
      .prepare(
        `SELECT status, COUNT(1) as count
         FROM plan_steps
         WHERE sessionId = ?
         GROUP BY status`
      )
      .all(sessionId) as Array<{ status: PlanStepStatus; count: number }>;

    const progress: Record<PlanStepStatus, number> = {
      pending: 0,
      in_progress: 0,
      blocked: 0,
      done: 0,
      skipped: 0
    };
    for (const row of rows) {
      progress[row.status] = row.count;
    }
    return progress;
  }

  listBlockers(sessionId: string): Array<{ stepId: string; title: string; note?: string }> {
    return (
      this.db
        .prepare(
          `SELECT stepId, title, note
           FROM plan_steps
           WHERE sessionId = ? AND status = 'blocked'
           ORDER BY orderIndex ASC`
        )
        .all(sessionId) as Array<{ stepId: string; title: string; note: string | null }>
    ).map((row) => ({
      stepId: row.stepId,
      title: row.title,
      note: row.note ?? undefined
    }));
  }

  countBySession(sessionId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(1) as count FROM plan_steps WHERE sessionId = ?")
      .get(sessionId) as { count: number };
    return row.count;
  }
}

function mapPlanRow(row: PlanRow): PlanRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    goal: row.goal,
    strategy: row.strategy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function mapStepRow(row: PlanStepRow): PlanStepRecord {
  return {
    stepId: row.stepId,
    planId: row.planId,
    sessionId: row.sessionId,
    orderIndex: row.orderIndex,
    title: row.title,
    objective: row.objective,
    dependsOn: JSON.parse(row.dependsOnJson) as string[],
    status: row.status,
    verification: JSON.parse(row.verificationJson) as PlanStepVerification,
    risk: row.risk,
    note: row.note ?? undefined,
    updatedAt: row.updatedAt
  };
}

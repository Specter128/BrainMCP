import { z } from "zod";
import { INPUT_LIMITS } from "./validation.js";

export const clientProfileSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    maxContextTokens: z.number().int().min(256).max(1_000_000).optional(),
    mode: z.enum(["small", "balanced", "deep"]).optional()
  })
  .strict();

export const healthInputSchema = z.object({}).strict();

export const createReasoningSessionInputSchema = z
  .object({
    title: z.string().min(1).max(240).optional(),
    clientProfile: clientProfileSchema.optional(),
    metadata: z
      .object({
        project: z.string().min(1).max(120).optional(),
        taskType: z.string().min(1).max(120).optional(),
        tags: z.array(z.string().min(1).max(64)).max(30).optional()
      })
      .strict()
      .optional()
  })
  .strict();

export const getReasoningSessionInputSchema = z
  .object({
    sessionId: z.string().min(1).max(120)
  })
  .strict();

const decisionLogKindSchema = z.enum([
  "decision",
  "observation",
  "risk",
  "checkpoint",
  "result",
  "note"
]);

export const writeDecisionLogInputSchema = z
  .object({
    sessionId: z.string().min(1).max(120),
    kind: decisionLogKindSchema,
    summary: z.string().min(1).max(INPUT_LIMITS.maxSummaryChars),
    details: z
      .object({
        rationale: z.string().max(INPUT_LIMITS.maxDetailChars).optional(),
        evidence: z.array(z.string().max(INPUT_LIMITS.maxDetailChars)).max(30).optional(),
        impact: z.string().max(INPUT_LIMITS.maxDetailChars).optional(),
        relatedStepIds: z.array(z.string().min(1).max(120)).max(60).optional(),
        relatedAssumptionIds: z.array(z.string().min(1).max(120)).max(60).optional()
      })
      .strict()
      .optional(),
    importance: z.enum(["low", "medium", "high"]).optional()
  })
  .strict();

export const readDecisionLogInputSchema = z
  .object({
    sessionId: z.string().min(1).max(120),
    limit: z.number().int().min(1).max(200).optional(),
    kinds: z.array(decisionLogKindSchema).max(6).optional(),
    since: z.string().datetime().optional()
  })
  .strict();

export const analyzeTaskInputSchema = z
  .object({
    sessionId: z.string().min(1).max(120).optional(),
    task: z.string().min(1).max(INPUT_LIMITS.maxTaskChars),
    constraints: z.array(z.string().min(1).max(300)).max(INPUT_LIMITS.maxArrayInput).optional(),
    context: z
      .object({
        domain: z.string().min(1).max(120).optional(),
        environment: z.string().min(1).max(120).optional(),
        existingPlan: z.string().min(1).max(INPUT_LIMITS.maxDetailChars).optional()
      })
      .strict()
      .optional(),
    clientProfile: clientProfileSchema.optional()
  })
  .strict();

export const decomposeTaskInputSchema = z
  .object({
    sessionId: z.string().min(1).max(120).optional(),
    task: z.string().min(1).max(INPUT_LIMITS.maxTaskChars),
    goal: z.string().min(1).max(400).optional(),
    constraints: z.array(z.string().min(1).max(300)).max(INPUT_LIMITS.maxArrayInput).optional(),
    mode: z.enum(["linear", "tree", "milestone"]).optional(),
    clientProfile: clientProfileSchema.optional()
  })
  .strict();

export const buildPlanInputSchema = z
  .object({
    sessionId: z.string().min(1).max(120),
    goal: z.string().min(1).max(500),
    subtasks: z
      .array(
        z
          .object({
            id: z.string().min(1).max(120),
            title: z.string().min(1).max(240),
            dependsOn: z.array(z.string().min(1).max(120)).max(40).optional()
          })
          .strict()
      )
      .max(80)
      .optional(),
    constraints: z.array(z.string().min(1).max(300)).max(INPUT_LIMITS.maxArrayInput).optional(),
    strategy: z.enum(["minimum-risk", "fastest", "balanced"]).optional(),
    includeCheckpoints: z.boolean().optional(),
    clientProfile: clientProfileSchema.optional()
  })
  .strict();

export const updatePlanStatusInputSchema = z
  .object({
    sessionId: z.string().min(1).max(120),
    updates: z
      .array(
        z
          .object({
            stepId: z.string().min(1).max(120),
            status: z.enum(["pending", "in_progress", "blocked", "done", "skipped"]),
            note: z.string().max(INPUT_LIMITS.maxDetailChars).optional()
          })
          .strict()
      )
      .min(1)
      .max(100)
  })
  .strict();

export const nextBestActionInputSchema = z
  .object({
    sessionId: z.string().min(1).max(120),
    currentContext: z
      .object({
        latestResult: z.string().max(INPUT_LIMITS.maxDetailChars).optional(),
        activeStepId: z.string().min(1).max(120).optional(),
        blockers: z.array(z.string().max(300)).max(40).optional(),
        openRisks: z.array(z.string().max(300)).max(40).optional()
      })
      .strict()
      .optional(),
    preference: z.enum(["progress", "safety", "validation", "unblock"]).optional(),
    clientProfile: clientProfileSchema.optional()
  })
  .strict();

export const listAssumptionsInputSchema = z
  .object({
    sessionId: z.string().min(1).max(120),
    sourceText: z.string().max(INPUT_LIMITS.maxTaskChars).optional(),
    includeImplicit: z.boolean().optional(),
    clientProfile: clientProfileSchema.optional()
  })
  .strict();

export const assumptionCheckInputSchema = z
  .object({
    sessionId: z.string().min(1).max(120),
    checks: z
      .array(
        z
          .object({
            assumptionId: z.string().min(1).max(120).optional(),
            text: z.string().min(1).max(400).optional(),
            evidenceAvailable: z.array(z.string().max(300)).max(40).optional(),
            statusHint: z.enum(["verified", "unverified", "risky"]).optional()
          })
          .strict()
      )
      .max(120)
      .optional(),
    strictness: z.enum(["standard", "strict"]).optional(),
    clientProfile: clientProfileSchema.optional()
  })
  .strict();

export const consistencyCheckInputSchema = z
  .object({
    sessionId: z.string().min(1).max(120).optional(),
    draft: z
      .object({
        claims: z.array(z.string().max(400)).max(INPUT_LIMITS.maxDraftItems).optional(),
        planText: z.string().max(INPUT_LIMITS.maxTaskChars).optional(),
        steps: z
          .array(
            z
              .object({
                id: z.string().min(1).max(120).optional(),
                text: z.string().min(1).max(300),
                dependsOn: z.array(z.string().min(1).max(120)).max(40).optional()
              })
              .strict()
          )
          .max(INPUT_LIMITS.maxDraftItems)
          .optional(),
        conclusions: z.array(z.string().max(400)).max(INPUT_LIMITS.maxDraftItems).optional()
      })
      .strict()
      .optional(),
    checkTargets: z
      .array(
        z.enum([
          "contradictions",
          "missing-steps",
          "circular-deps",
          "unsupported-claims",
          "goal-drift"
        ])
      )
      .max(5)
      .optional(),
    clientProfile: clientProfileSchema.optional()
  })
  .strict();

export const criticReviewInputSchema = z
  .object({
    sessionId: z.string().min(1).max(120).optional(),
    subject: z
      .object({
        type: z.enum(["plan", "proposal", "draft-answer", "approach", "decision-set"]),
        text: z.string().max(INPUT_LIMITS.maxTaskChars).optional(),
        structured: z.unknown().optional()
      })
      .strict(),
    rubric: z
      .object({
        correctness: z.number().min(0).max(5).optional(),
        completeness: z.number().min(0).max(5).optional(),
        risk: z.number().min(0).max(5).optional(),
        testability: z.number().min(0).max(5).optional(),
        simplicity: z.number().min(0).max(5).optional(),
        maintainability: z.number().min(0).max(5).optional()
      })
      .strict()
      .optional(),
    style: z.enum(["strict", "balanced", "coaching"]).optional(),
    clientProfile: clientProfileSchema.optional()
  })
  .strict();

export const compactReasoningStateInputSchema = z
  .object({
    sessionId: z.string().min(1).max(120),
    targetTokens: z.number().int().min(50).max(100_000).optional(),
    preserve: z
      .array(
        z.enum([
          "goal",
          "constraints",
          "open-risks",
          "assumptions",
          "current-plan",
          "recent-results",
          "decisions"
        ])
      )
      .max(7)
      .optional(),
    clientProfile: clientProfileSchema.optional()
  })
  .strict();

export const optionalSessionSchema = z.object({ sessionId: z.string().min(1).max(120).optional() });

export type ClientProfileInput = z.infer<typeof clientProfileSchema>;

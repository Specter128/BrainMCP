import type { AssumptionRecord } from "../storage/repositories/assumptions.js";
import type { DecisionLogRecord } from "../storage/repositories/decisionLogs.js";
import type { PlanStepRecord } from "../storage/repositories/plans.js";
import { capItems, sanitizeText, type ResponsePolicy } from "../utils/validation.js";

export type ActionType =
  | "execute-step"
  | "verify-assumption"
  | "run-review"
  | "resolve-blocker"
  | "revise-plan"
  | "gather-evidence";

export type NextActionInput = {
  planSteps: PlanStepRecord[];
  assumptions: AssumptionRecord[];
  decisionLogs: DecisionLogRecord[];
  currentContext?: {
    latestResult?: string;
    activeStepId?: string;
    blockers?: string[];
    openRisks?: string[];
  };
  preference?: "progress" | "safety" | "validation" | "unblock";
  policy: ResponsePolicy;
};

export type NextActionOutput = {
  recommendation: {
    type: ActionType;
    title: string;
    reason: string;
    targetStepId?: string;
  };
  alternatives: Array<{
    type: ActionType;
    title: string;
    tradeoff: string;
  }>;
  prerequisites: string[];
};

type Candidate = {
  type: ActionType;
  title: string;
  reason: string;
  tradeoff: string;
  score: number;
  targetStepId?: string;
  prerequisites: string[];
};

export function selectNextBestAction(input: NextActionInput): NextActionOutput {
  const candidates = buildCandidates(input);
  const sorted = candidates.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  const best = sorted[0] ?? fallbackCandidate(input.policy);
  const alternatives = capItems(
    sorted
      .slice(1)
      .map((candidate) => ({
        type: candidate.type,
        title: sanitizeText(candidate.title, input.policy.textMaxChars),
        tradeoff: sanitizeText(candidate.tradeoff, input.policy.textMaxChars)
      })),
    input.policy.maxAlternatives
  );

  return {
    recommendation: {
      type: best.type,
      title: sanitizeText(best.title, input.policy.textMaxChars),
      reason: sanitizeText(best.reason, input.policy.textMaxChars),
      targetStepId: best.targetStepId
    },
    alternatives,
    prerequisites: capItems(
      best.prerequisites.map((value) => sanitizeText(value, input.policy.textMaxChars)),
      input.policy.maxGenericItems
    )
  };
}

function buildCandidates(input: NextActionInput): Candidate[] {
  const preference = input.preference ?? "progress";
  const candidates: Candidate[] = [];
  const blockedSteps = input.planSteps.filter((step) => step.status === "blocked");
  const inProgress = input.planSteps.find((step) => step.status === "in_progress");
  const pending = input.planSteps.find((step) => step.status === "pending");
  const riskyAssumptions = input.assumptions.filter(
    (item) => item.status === "risky" || item.status === "contradicted"
  );
  const highRiskUnverified = input.assumptions.filter(
    (item) => item.status !== "verified" && item.risk === "high"
  );
  const openContextBlockers = input.currentContext?.blockers ?? [];
  const openContextRisks = input.currentContext?.openRisks ?? [];

  if (blockedSteps.length > 0 || openContextBlockers.length > 0) {
    const step = blockedSteps[0];
    candidates.push({
      type: "resolve-blocker",
      title: step
        ? `Resolve blocker on ${step.stepId}`
        : "Resolve active blocker from current context",
      reason: "Blocked execution prevents further progress on plan.",
      tradeoff: "Unblocking may require scope adjustment before new progress.",
      score: 92 + preferenceBoost(preference, "resolve-blocker"),
      targetStepId: step?.stepId,
      prerequisites: [
        "Identify blocker root cause.",
        "Add mitigation decision log entry.",
        "Update impacted plan step status."
      ]
    });
  }

  if (riskyAssumptions.length > 0 || highRiskUnverified.length > 0) {
    const target = (riskyAssumptions[0] ?? highRiskUnverified[0])?.assumptionId;
    candidates.push({
      type: "verify-assumption",
      title: "Verify highest-risk assumption",
      reason: "Unverified high-risk assumptions can invalidate downstream steps.",
      tradeoff: "Verification adds short-term overhead but reduces rework.",
      score: 84 + preferenceBoost(preference, "verify-assumption"),
      prerequisites: [
        "Gather concrete evidence for assumption status.",
        "Run assumption_check with strictness='strict'."
      ],
      targetStepId: target
    });
  }

  if (inProgress) {
    candidates.push({
      type: "execute-step",
      title: `Advance current in-progress step ${inProgress.stepId}`,
      reason: "Active work should complete before expanding scope.",
      tradeoff: "May postpone risk review until this step is completed.",
      score: 80 + preferenceBoost(preference, "execute-step"),
      targetStepId: inProgress.stepId,
      prerequisites: missingDependencies(inProgress, input.planSteps)
    });
  } else if (pending) {
    candidates.push({
      type: "execute-step",
      title: `Start next pending step ${pending.stepId}`,
      reason: "No active work in progress and pending step is ready.",
      tradeoff: "Proceeding now may surface unresolved assumptions later.",
      score: 74 + preferenceBoost(preference, "execute-step"),
      targetStepId: pending.stepId,
      prerequisites: missingDependencies(pending, input.planSteps)
    });
  }

  const recentResults = input.decisionLogs.filter((log) => log.kind === "result");
  if (recentResults.length === 0 || openContextRisks.length > 0) {
    candidates.push({
      type: "gather-evidence",
      title: "Gather supporting evidence for current state",
      reason: "Evidence is limited relative to open risks and planned conclusions.",
      tradeoff: "Evidence collection delays execution but improves confidence.",
      score: 72 + preferenceBoost(preference, "gather-evidence"),
      prerequisites: [
        "Collect result/checkpoint logs tied to active step.",
        "Link evidence to assumptions or risk entries."
      ]
    });
  }

  const hasBlockedOrSkipped = input.planSteps.some(
    (step) => step.status === "blocked" || step.status === "skipped"
  );
  if (hasBlockedOrSkipped) {
    candidates.push({
      type: "revise-plan",
      title: "Revise plan for blocked/skipped path",
      reason: "Plan no longer matches execution reality and needs adaptation.",
      tradeoff: "Replanning can add overhead but reduces thrash.",
      score: 76 + preferenceBoost(preference, "revise-plan"),
      prerequisites: [
        "Re-check dependencies and risk levels.",
        "Rebuild plan checkpoints if strategy changed."
      ]
    });
  }

  candidates.push({
    type: "run-review",
    title: "Run structured consistency and critic review",
    reason: "Review helps prevent latent inconsistencies before execution continues.",
    tradeoff: "Additional review time, but lower defect risk.",
    score: 65 + preferenceBoost(preference, "run-review"),
    prerequisites: ["Run consistency_check and critic_review on current plan state."]
  });

  return dedupeCandidates(candidates);
}

function preferenceBoost(preference: string, type: ActionType): number {
  const matrix: Record<string, Partial<Record<ActionType, number>>> = {
    progress: {
      "execute-step": 8,
      "resolve-blocker": 6
    },
    safety: {
      "verify-assumption": 10,
      "gather-evidence": 8,
      "run-review": 6
    },
    validation: {
      "run-review": 10,
      "verify-assumption": 6
    },
    unblock: {
      "resolve-blocker": 12,
      "revise-plan": 6
    }
  };
  return matrix[preference]?.[type] ?? 0;
}

function missingDependencies(step: PlanStepRecord, allSteps: PlanStepRecord[]): string[] {
  const byId = new Map(allSteps.map((item) => [item.stepId, item] as const));
  const missing = step.dependsOn.filter((depId) => {
    const dep = byId.get(depId);
    return !dep || dep.status !== "done";
  });
  if (missing.length === 0) {
    return ["No unmet prerequisites detected."];
  }
  return missing.map((id) => `Complete dependency ${id} before execution.`);
}

function dedupeCandidates(candidates: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  const unique: Candidate[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.type}|${candidate.targetStepId ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(candidate);
  }
  return unique;
}

function fallbackCandidate(policy: ResponsePolicy): Candidate {
  return {
    type: "run-review",
    title: "Run minimal review cycle",
    reason: "Insufficient state to pick stronger recommendation.",
    tradeoff: "Review first, then continue execution.",
    score: 1,
    prerequisites: ["Capture plan, assumptions, and latest results before proceeding."]
  };
}

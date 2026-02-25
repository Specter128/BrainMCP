import { newId } from "../utils/ids.js";
import { capItems, sanitizeText, type ResponsePolicy } from "../utils/validation.js";
import type { AssumptionRecord } from "../storage/repositories/assumptions.js";
import type { PlanStepRecord } from "../storage/repositories/plans.js";
import type { DecisionLogRecord } from "../storage/repositories/decisionLogs.js";

export type ConsistencyIssueType =
  | "contradiction"
  | "missing-step"
  | "circular-dependency"
  | "unsupported-claim"
  | "goal-drift";

export type ConsistencyCheckInput = {
  draft?: {
    claims?: string[];
    planText?: string;
    steps?: { id?: string; text: string; dependsOn?: string[] }[];
    conclusions?: string[];
  };
  checkTargets?: Array<
    "contradictions" | "missing-steps" | "circular-deps" | "unsupported-claims" | "goal-drift"
  >;
  normalizedGoal?: string;
  sessionPlanSteps?: PlanStepRecord[];
  sessionAssumptions?: AssumptionRecord[];
  recentDecisionLogs?: DecisionLogRecord[];
  policy: ResponsePolicy;
};

export type ConsistencyIssue = {
  issueId: string;
  type: ConsistencyIssueType;
  severity: "low" | "medium" | "high";
  description: string;
  affectedItems: string[];
  suggestedFix: string;
};

export function runConsistencyCheck(input: ConsistencyCheckInput): {
  issues: ConsistencyIssue[];
  summary: { total: number; highSeverity: number; pass: boolean };
} {
  const targets = new Set(
    input.checkTargets ?? [
      "contradictions",
      "missing-steps",
      "circular-deps",
      "unsupported-claims",
      "goal-drift"
    ]
  );

  const draft = input.draft ?? {};
  const claims = draft.claims ?? [];
  const conclusions = draft.conclusions ?? [];
  const planText = draft.planText ?? "";
  const steps =
    draft.steps?.map((step, index) => ({
      id: step.id ?? `draft_step_${index + 1}`,
      text: step.text,
      dependsOn: step.dependsOn ?? []
    })) ??
    input.sessionPlanSteps?.map((step) => ({
      id: step.stepId,
      text: step.title,
      dependsOn: step.dependsOn
    })) ??
    [];

  const issues: ConsistencyIssue[] = [];

  if (targets.has("contradictions")) {
    issues.push(...detectContradictions(claims, conclusions, input.policy));
  }
  if (targets.has("missing-steps")) {
    issues.push(...detectMissingSteps(steps, planText, conclusions, input.policy));
  }
  if (targets.has("circular-deps")) {
    issues.push(...detectCircularDependencies(steps, input.policy));
  }
  if (targets.has("unsupported-claims")) {
    issues.push(
      ...detectUnsupportedClaims(
        claims,
        conclusions,
        input.sessionAssumptions,
        input.recentDecisionLogs,
        input.policy
      )
    );
  }
  if (targets.has("goal-drift")) {
    issues.push(
      ...detectGoalDrift(
        input.normalizedGoal,
        claims,
        conclusions,
        steps.map((step) => step.text),
        planText,
        input.policy
      )
    );
  }

  const capped = capItems(issues, input.policy.maxFindings);
  return {
    issues: capped,
    summary: {
      total: capped.length,
      highSeverity: capped.filter((issue) => issue.severity === "high").length,
      pass: capped.length === 0
    }
  };
}

function detectContradictions(
  claims: string[],
  conclusions: string[],
  policy: ResponsePolicy
): ConsistencyIssue[] {
  const issues: ConsistencyIssue[] = [];
  const allComparisons: Array<[string, string]> = [];
  for (const claim of claims) {
    for (const conclusion of conclusions) {
      allComparisons.push([claim, conclusion]);
    }
  }

  for (const [a, b] of allComparisons) {
    if (isContradictoryPair(a, b)) {
      issues.push(
        makeIssue(
          "contradiction",
          "high",
          `Potential contradiction detected between claim and conclusion.`,
          [a, b],
          "Align conclusion with supporting claim or add missing evidence.",
          policy
        )
      );
    }
  }
  return issues;
}

function detectMissingSteps(
  steps: Array<{ id: string; text: string; dependsOn: string[] }>,
  planText: string,
  conclusions: string[],
  policy: ResponsePolicy
): ConsistencyIssue[] {
  const issues: ConsistencyIssue[] = [];
  const indexById = new Map(steps.map((step, index) => [step.id, index] as const));

  if (conclusions.length > 0 && steps.length === 0) {
    issues.push(
      makeIssue(
        "missing-step",
        "high",
        "Conclusions provided without supporting execution steps.",
        conclusions,
        "Add explicit steps that produce evidence for each conclusion.",
        policy
      )
    );
    return issues;
  }

  for (const [index, step] of steps.entries()) {
    for (const depId of step.dependsOn) {
      const depIndex = indexById.get(depId);
      if (depIndex === undefined) {
        issues.push(
          makeIssue(
            "missing-step",
            "high",
            `Step '${step.id}' depends on undefined step '${depId}'.`,
            [step.id, depId],
            "Define the missing dependency or remove invalid reference.",
            policy
          )
        );
      } else if (depIndex > index) {
        issues.push(
          makeIssue(
            "missing-step",
            "medium",
            `Step '${step.id}' depends on future step '${depId}'.`,
            [step.id, depId],
            "Reorder steps so dependencies complete earlier.",
            policy
          )
        );
      }
    }
  }

  const lowerSteps = steps.map((step) => step.text.toLowerCase()).join(" ");
  if (/\bdeploy|release|production\b/i.test(planText) && !/\bdeploy|release|production\b/.test(lowerSteps)) {
    issues.push(
      makeIssue(
        "missing-step",
        "medium",
        "Plan text references deployment but no deployment step was found.",
        [planText],
        "Add a deployment or rollout step with verification.",
        policy
      )
    );
  }
  return issues;
}

function detectCircularDependencies(
  steps: Array<{ id: string; text: string; dependsOn: string[] }>,
  policy: ResponsePolicy
): ConsistencyIssue[] {
  const issues: ConsistencyIssue[] = [];
  const edges = new Map<string, string[]>();
  for (const step of steps) {
    edges.set(step.id, step.dependsOn);
  }

  const visited = new Set<string>();
  const stack = new Set<string>();

  const dfs = (node: string): void => {
    if (stack.has(node)) {
      issues.push(
        makeIssue(
          "circular-dependency",
          "high",
          `Circular dependency detected at '${node}'.`,
          [node],
          "Remove cycle by introducing linear dependency progression.",
          policy
        )
      );
      return;
    }
    if (visited.has(node)) {
      return;
    }
    visited.add(node);
    stack.add(node);
    const deps = edges.get(node) ?? [];
    for (const dep of deps) {
      if (edges.has(dep)) {
        dfs(dep);
      }
    }
    stack.delete(node);
  };

  for (const step of steps) {
    dfs(step.id);
  }
  return issues;
}

function detectUnsupportedClaims(
  claims: string[],
  conclusions: string[],
  assumptions: AssumptionRecord[] | undefined,
  decisionLogs: DecisionLogRecord[] | undefined,
  policy: ResponsePolicy
): ConsistencyIssue[] {
  const issues: ConsistencyIssue[] = [];
  if (claims.length === 0 && conclusions.length > 0) {
    issues.push(
      makeIssue(
        "unsupported-claim",
        "high",
        "Conclusions exist without explicit supporting claims.",
        conclusions,
        "Add supporting claims or evidence before finalizing conclusions.",
        policy
      )
    );
  }

  if (conclusions.length > 0) {
    const verifiedAssumptions = assumptions?.filter((item) => item.status === "verified") ?? [];
    const evidenceLogs =
      decisionLogs?.filter((log) => log.kind === "result" || log.kind === "checkpoint") ?? [];
    if (verifiedAssumptions.length === 0 && evidenceLogs.length === 0) {
      issues.push(
        makeIssue(
          "unsupported-claim",
          "high",
          "Conclusions are not backed by verified assumptions or evidence logs.",
          conclusions.slice(0, 3),
          "Verify assumptions and log concrete evidence before final conclusions.",
          policy
        )
      );
    }
  }

  for (const claim of claims) {
    if (/\b(because|therefore|proves|confirmed)\b/i.test(claim)) {
      const hasEvidence =
        (decisionLogs ?? []).some((log) =>
          [log.summary, ...(log.details?.evidence ?? [])]
            .join(" ")
            .toLowerCase()
            .includes(extractClaimAnchor(claim))
        ) || false;
      if (!hasEvidence) {
        issues.push(
          makeIssue(
            "unsupported-claim",
            "medium",
            `Claim appears evidential but no supporting evidence log was found.`,
            [claim],
            "Record evidence in decision logs or weaken claim confidence.",
            policy
          )
        );
      }
    }
  }
  return issues;
}

function detectGoalDrift(
  normalizedGoal: string | undefined,
  claims: string[],
  conclusions: string[],
  stepTexts: string[],
  planText: string,
  policy: ResponsePolicy
): ConsistencyIssue[] {
  if (!normalizedGoal) {
    return [];
  }
  const goalKeywords = keywordSet(normalizedGoal);
  if (goalKeywords.size === 0) {
    return [];
  }

  const corpus = [...claims, ...conclusions, ...stepTexts, planText].join(" ");
  const corpusKeywords = keywordSet(corpus);
  const overlap = [...goalKeywords].filter((keyword) => corpusKeywords.has(keyword)).length;
  const ratio = overlap / goalKeywords.size;

  if (ratio >= 0.3) {
    return [];
  }

  return [
    makeIssue(
      "goal-drift",
      ratio < 0.15 ? "high" : "medium",
      "Current draft appears to drift from normalized goal keywords.",
      [normalizedGoal],
      "Revise plan and conclusions to align with stated goal.",
      policy
    )
  ];
}

function isContradictoryPair(a: string, b: string): boolean {
  const aHasNegation = /\b(no|not|never|cannot|can't|without|failed)\b/i.test(a);
  const bHasNegation = /\b(no|not|never|cannot|can't|without|failed)\b/i.test(b);
  if (aHasNegation === bHasNegation) {
    return false;
  }
  const aKeywords = keywordSet(a);
  const bKeywords = keywordSet(b);
  const overlap = [...aKeywords].filter((keyword) => bKeywords.has(keyword)).length;
  return overlap >= 2;
}

function keywordSet(text: string): Set<string> {
  const stopwords = new Set([
    "the",
    "a",
    "an",
    "and",
    "or",
    "to",
    "for",
    "of",
    "in",
    "on",
    "with",
    "is",
    "are",
    "be",
    "by",
    "this",
    "that"
  ]);
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length >= 4 && !stopwords.has(token))
  );
}

function extractClaimAnchor(claim: string): string {
  return claim
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 5)[0] ?? "";
}

function makeIssue(
  type: ConsistencyIssueType,
  severity: "low" | "medium" | "high",
  description: string,
  affectedItems: string[],
  suggestedFix: string,
  policy: ResponsePolicy
): ConsistencyIssue {
  return {
    issueId: newId("issue"),
    type,
    severity,
    description: sanitizeText(description, policy.textMaxChars),
    affectedItems: capItems(
      affectedItems.map((item) => sanitizeText(item, policy.textMaxChars)),
      policy.maxGenericItems
    ),
    suggestedFix: sanitizeText(suggestedFix, policy.textMaxChars)
  };
}

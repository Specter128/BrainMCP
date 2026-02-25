import { capItems, sanitizeText, type ResponsePolicy } from "../utils/validation.js";

export type PlanStrategy = "minimum-risk" | "fastest" | "balanced";
export type StepStatus = "pending" | "in_progress" | "blocked" | "done" | "skipped";
export type VerificationType =
  | "logic-check"
  | "evidence-check"
  | "test-check"
  | "review-check"
  | "manual-check";

export type BuildPlanInput = {
  goal: string;
  subtasks?: Array<{ id: string; title: string; dependsOn?: string[] }>;
  constraints?: string[];
  strategy?: PlanStrategy;
  includeCheckpoints?: boolean;
  policy: ResponsePolicy;
};

export type BuildPlanOutput = {
  strategy: PlanStrategy;
  steps: Array<{
    stepId: string;
    order: number;
    title: string;
    objective: string;
    dependsOn: string[];
    status: "pending";
    verification: {
      required: boolean;
      type: VerificationType;
      hint: string;
    };
    risk: "low" | "medium" | "high";
  }>;
  checkpoints: Array<{
    checkpointId: string;
    afterStepId: string;
    purpose: string;
  }>;
  planSummary: {
    totalSteps: number;
    highRiskSteps: number;
    verificationPoints: number;
  };
};

type NormalizedSubtask = {
  id: string;
  title: string;
  dependsOn: string[];
};

export function buildPlan(input: BuildPlanInput): BuildPlanOutput {
  const strategy = input.strategy ?? "balanced";
  const includeCheckpoints = input.includeCheckpoints ?? true;
  const baseSubtasks = normalizeSubtasks(input.goal, input.subtasks, input.policy);

  const strategySubtasks =
    strategy === "fastest"
      ? compressForFastest(baseSubtasks, input.policy)
      : strategy === "minimum-risk"
        ? expandForRisk(baseSubtasks, input.policy)
        : baseSubtasks;

  const cappedSubtasks = capItems(strategySubtasks, Math.max(3, input.policy.maxSubtasks));
  const ordered = topologicalOrder(cappedSubtasks);

  const steps = ordered.map((subtask, index) => {
    const risk = inferRisk(subtask.title, input.constraints, subtask.dependsOn.length);
    const verificationType = inferVerificationType(subtask.title, strategy);
    const verificationRequired = strategy !== "fastest" || risk !== "low";
    return {
      stepId: `step_${index + 1}`,
      order: index + 1,
      title: sanitizeText(subtask.title, input.policy.shortTextMaxChars),
      objective: sanitizeText(
        `${subtask.title}. Outcome must advance goal: ${input.goal}`,
        input.policy.textMaxChars
      ),
      dependsOn: resolveStepDependencies(subtask.dependsOn, ordered, index),
      status: "pending" as const,
      verification: {
        required: verificationRequired,
        type: verificationType,
        hint: sanitizeText(verificationHint(subtask.title, verificationType), input.policy.textMaxChars)
      },
      risk
    };
  });

  const checkpoints = includeCheckpoints
    ? generateCheckpoints(steps, strategy, input.policy)
    : [];

  return {
    strategy,
    steps,
    checkpoints,
    planSummary: {
      totalSteps: steps.length,
      highRiskSteps: steps.filter((step) => step.risk === "high").length,
      verificationPoints: steps.filter((step) => step.verification.required).length + checkpoints.length
    }
  };
}

function normalizeSubtasks(
  goal: string,
  provided: BuildPlanInput["subtasks"],
  policy: ResponsePolicy
): NormalizedSubtask[] {
  if (provided?.length) {
    return provided.map((subtask) => ({
      id: subtask.id,
      title: sanitizeText(subtask.title, policy.textMaxChars),
      dependsOn: subtask.dependsOn ?? []
    }));
  }

  const fallback = [
    "Clarify acceptance criteria",
    "Prepare execution context",
    "Implement core solution",
    "Verify and finalize output"
  ];

  return fallback.map((title, index) => ({
    id: `subtask_auto_${index + 1}`,
    title: sanitizeText(title, policy.textMaxChars),
    dependsOn: index === 0 ? [] : [`subtask_auto_${index}`]
  }));
}

function compressForFastest(subtasks: NormalizedSubtask[], policy: ResponsePolicy): NormalizedSubtask[] {
  if (subtasks.length <= 4) {
    return subtasks;
  }
  const compressed: NormalizedSubtask[] = [];
  for (let i = 0; i < subtasks.length; i += 2) {
    const first = subtasks[i];
    const second = subtasks[i + 1];
    if (!first) {
      continue;
    }
    if (!second) {
      compressed.push(first);
      continue;
    }
    compressed.push({
      id: `merged_${compressed.length + 1}`,
      title: sanitizeText(`${first.title} + ${second.title}`, policy.textMaxChars),
      dependsOn: [...new Set([...first.dependsOn, ...second.dependsOn])]
    });
  }
  return compressed;
}

function expandForRisk(subtasks: NormalizedSubtask[], policy: ResponsePolicy): NormalizedSubtask[] {
  const expanded: NormalizedSubtask[] = [];
  for (const subtask of subtasks) {
    expanded.push(subtask);
    if (inferRisk(subtask.title, [], subtask.dependsOn.length) !== "low") {
      expanded.push({
        id: `${subtask.id}_verify`,
        title: sanitizeText(`Validate ${subtask.title}`, policy.textMaxChars),
        dependsOn: [subtask.id]
      });
    }
  }
  return expanded;
}

function topologicalOrder(subtasks: NormalizedSubtask[]): NormalizedSubtask[] {
  const byId = new Map(subtasks.map((subtask) => [subtask.id, subtask] as const));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const ordered: NormalizedSubtask[] = [];

  const visit = (id: string): void => {
    if (visited.has(id)) {
      return;
    }
    if (visiting.has(id)) {
      return;
    }
    visiting.add(id);
    const node = byId.get(id);
    if (!node) {
      visiting.delete(id);
      return;
    }
    for (const depId of node.dependsOn) {
      if (byId.has(depId)) {
        visit(depId);
      }
    }
    visiting.delete(id);
    visited.add(id);
    ordered.push(node);
  };

  for (const subtask of subtasks) {
    visit(subtask.id);
  }
  return ordered;
}

function resolveStepDependencies(
  originalDependencies: string[],
  ordered: NormalizedSubtask[],
  currentIndex: number
): string[] {
  const indexById = new Map(ordered.map((item, index) => [item.id, index] as const));
  const stepIdByIndex = (index: number): string => `step_${index + 1}`;
  const mapped = originalDependencies
    .map((dependency) => indexById.get(dependency))
    .filter((index): index is number => index !== undefined && index < currentIndex)
    .map(stepIdByIndex);
  if (mapped.length > 0) {
    return mapped;
  }
  if (currentIndex === 0) {
    return [];
  }
  return [stepIdByIndex(currentIndex - 1)];
}

function inferRisk(
  title: string,
  constraints: string[] | undefined,
  dependencyCount: number
): "low" | "medium" | "high" {
  const lc = title.toLowerCase();
  let score = 0;
  if (/\b(implement|migration|security|auth|deploy|validate)\b/.test(lc)) {
    score += 2;
  }
  if (/\b(design|architecture|integration|dependency)\b/.test(lc)) {
    score += 2;
  }
  if (dependencyCount >= 2) {
    score += 1;
  }
  if ((constraints?.length ?? 0) >= 5) {
    score += 1;
  }
  if (score >= 4) {
    return "high";
  }
  if (score >= 2) {
    return "medium";
  }
  return "low";
}

function inferVerificationType(title: string, strategy: PlanStrategy): VerificationType {
  const lc = title.toLowerCase();
  if (/\b(test|verify|regression)\b/.test(lc)) {
    return "test-check";
  }
  if (/\b(review|analyz|assess|design)\b/.test(lc)) {
    return "review-check";
  }
  if (/\b(evidence|assumption|dependency)\b/.test(lc)) {
    return "evidence-check";
  }
  if (strategy === "fastest") {
    return "manual-check";
  }
  return "logic-check";
}

function verificationHint(title: string, type: VerificationType): string {
  switch (type) {
    case "test-check":
      return `Run targeted verification for '${title}' and capture pass/fail evidence.`;
    case "review-check":
      return `Perform structured review for '${title}' against constraints and goal.`;
    case "evidence-check":
      return `Collect objective evidence proving '${title}' assumptions hold.`;
    case "manual-check":
      return `Perform quick manual validation for '${title}' before progressing.`;
    default:
      return `Validate logical consistency for '${title}' and dependency completion.`;
  }
}

function generateCheckpoints(
  steps: BuildPlanOutput["steps"],
  strategy: PlanStrategy,
  policy: ResponsePolicy
): BuildPlanOutput["checkpoints"] {
  const checkpoints: BuildPlanOutput["checkpoints"] = [];
  const shouldInsert = (step: BuildPlanOutput["steps"][number], index: number): boolean => {
    if (strategy === "minimum-risk") {
      return step.risk !== "low" || index % 2 === 1;
    }
    if (strategy === "fastest") {
      return index === steps.length - 1;
    }
    return step.risk === "high" || index % 3 === 2;
  };

  for (const [index, step] of steps.entries()) {
    if (!shouldInsert(step, index)) {
      continue;
    }
    checkpoints.push({
      checkpointId: `checkpoint_${checkpoints.length + 1}`,
      afterStepId: step.stepId,
      purpose: sanitizeText(
        step.risk === "high"
          ? "High-risk gate: verify assumptions and consistency."
          : "Progress gate: confirm readiness for next phase.",
        policy.textMaxChars
      )
    });
  }
  return checkpoints;
}

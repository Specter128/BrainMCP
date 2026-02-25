import { detectTaskType } from "./analyze.js";
import { capItems, sanitizeText, type ResponsePolicy } from "../utils/validation.js";

export type DecompositionMode = "linear" | "tree" | "milestone";

export type DecomposeTaskInput = {
  task: string;
  goal?: string;
  constraints?: string[];
  mode?: DecompositionMode;
  policy: ResponsePolicy;
};

export type DecomposeTaskOutput = {
  decompositionMode: DecompositionMode;
  subtasks: Array<{
    id: string;
    title: string;
    description: string;
    dependsOn: string[];
    complexity: "low" | "medium" | "high";
    risk: "low" | "medium" | "high";
    verificationHint?: string;
  }>;
  criticalPath: string[];
  parallelizableGroups: string[][];
};

type TemplateSubtask = {
  title: string;
  description: string;
  complexity: "low" | "medium" | "high";
  risk: "low" | "medium" | "high";
  verificationHint?: string;
};

const TEMPLATES: Record<string, TemplateSubtask[]> = {
  coding: [
    {
      title: "Clarify implementation scope",
      description: "Lock requirements, interfaces, and acceptance conditions.",
      complexity: "medium",
      risk: "medium",
      verificationHint: "Check requirement coverage before coding."
    },
    {
      title: "Map existing system boundaries",
      description: "Identify modules, dependencies, and integration points to avoid regressions.",
      complexity: "medium",
      risk: "medium",
      verificationHint: "List impacted files/components and dependency edges."
    },
    {
      title: "Design deterministic solution",
      description: "Define architecture and failure handling before implementation.",
      complexity: "high",
      risk: "high",
      verificationHint: "Review design against constraints and edge cases."
    },
    {
      title: "Implement incremental changes",
      description: "Deliver scoped updates in small verifiable increments.",
      complexity: "high",
      risk: "high",
      verificationHint: "Each increment should map to a planned verification."
    },
    {
      title: "Run verification workflow",
      description: "Validate behavior with logic checks and external test tooling.",
      complexity: "medium",
      risk: "high",
      verificationHint: "Capture evidence of pass/fail outcomes."
    },
    {
      title: "Document outcomes and next actions",
      description: "Summarize decisions, known risks, and follow-up work.",
      complexity: "low",
      risk: "low",
      verificationHint: "Ensure unresolved risks are tracked in decision log."
    }
  ],
  debugging: [
    {
      title: "Define failure signature",
      description: "Capture reproducible symptoms and expected behavior mismatch.",
      complexity: "medium",
      risk: "medium",
      verificationHint: "Write reproducibility checklist."
    },
    {
      title: "Collect diagnostic evidence",
      description: "Gather logs, traces, and state transitions around failure path.",
      complexity: "medium",
      risk: "medium",
      verificationHint: "Evidence should isolate at least one suspect layer."
    },
    {
      title: "Identify root cause",
      description: "Validate causal chain from trigger to observed failure.",
      complexity: "high",
      risk: "high",
      verificationHint: "Link every claim to evidence."
    },
    {
      title: "Implement fix with safeguards",
      description: "Apply minimal change that resolves root cause and limits regressions.",
      complexity: "high",
      risk: "high",
      verificationHint: "Include regression guard or verification checks."
    },
    {
      title: "Verify fix and regressions",
      description: "Confirm original issue resolved and nearby flows remain stable.",
      complexity: "medium",
      risk: "high",
      verificationHint: "Run targeted verification scenarios."
    }
  ],
  architecture: [
    {
      title: "Define architecture goals",
      description: "Align quality attributes, constraints, and non-goals.",
      complexity: "medium",
      risk: "medium"
    },
    {
      title: "Model solution components",
      description: "Describe modules, boundaries, and data/control flow.",
      complexity: "high",
      risk: "high"
    },
    {
      title: "Analyze tradeoffs and risks",
      description: "Evaluate alternatives, failure modes, and operational concerns.",
      complexity: "high",
      risk: "high"
    },
    {
      title: "Define rollout and verification plan",
      description: "Convert architecture into milestones and validation checkpoints.",
      complexity: "medium",
      risk: "medium"
    }
  ],
  planning: [
    {
      title: "Scope objective and boundaries",
      description: "Clarify what is in and out of scope.",
      complexity: "low",
      risk: "medium"
    },
    {
      title: "Break work into milestones",
      description: "Create executable milestones with explicit dependencies.",
      complexity: "medium",
      risk: "medium"
    },
    {
      title: "Assign verification checkpoints",
      description: "Add gates to detect risk early and avoid late surprises.",
      complexity: "medium",
      risk: "medium"
    },
    {
      title: "Define monitoring and fallback",
      description: "Track progress and fallback paths for blocked milestones.",
      complexity: "medium",
      risk: "high"
    }
  ],
  analysis: [
    {
      title: "Collect relevant inputs",
      description: "Identify datasets, assumptions, and context needed for analysis.",
      complexity: "medium",
      risk: "medium"
    },
    {
      title: "Evaluate competing explanations",
      description: "Compare candidate interpretations and eliminate weak options.",
      complexity: "high",
      risk: "medium"
    },
    {
      title: "Assess risk and confidence",
      description: "Classify confidence levels and residual uncertainty.",
      complexity: "medium",
      risk: "high"
    },
    {
      title: "Produce recommendations",
      description: "Translate findings into prioritized actions and verification needs.",
      complexity: "medium",
      risk: "medium"
    }
  ],
  mixed: [
    {
      title: "Clarify objective and inputs",
      description: "Establish goal, context, and explicit constraints.",
      complexity: "medium",
      risk: "medium"
    },
    {
      title: "Decompose into executable tracks",
      description: "Split work into analysis, implementation, and validation tracks.",
      complexity: "high",
      risk: "high"
    },
    {
      title: "Sequence dependencies",
      description: "Order tracks to reduce blockers and rework risk.",
      complexity: "medium",
      risk: "medium"
    },
    {
      title: "Validate and consolidate outputs",
      description: "Run quality checks and merge into final actionable state.",
      complexity: "medium",
      risk: "high"
    }
  ]
};

export function decomposeTask(input: DecomposeTaskInput): DecomposeTaskOutput {
  const mode = input.mode ?? "linear";
  const taskType = detectTaskType(input.task);
  const template = [...(TEMPLATES[taskType] ?? TEMPLATES.mixed)];
  if ((input.constraints?.length ?? 0) >= 4) {
    template.splice(template.length - 1, 0, {
      title: "Validate constraint satisfaction",
      description: "Ensure all hard constraints are mapped to specific deliverables.",
      complexity: "medium",
      risk: "high",
      verificationHint: "Create explicit constraint-to-step matrix."
    });
  }

  const capped = capItems(template, input.policy.maxSubtasks);
  const subtasks = capped.map((item, index) => ({
    id: `subtask_${index + 1}`,
    title: sanitizeText(item.title, input.policy.shortTextMaxChars),
    description: sanitizeText(item.description, input.policy.textMaxChars),
    dependsOn: [] as string[],
    complexity: item.complexity,
    risk: item.risk,
    verificationHint: item.verificationHint
      ? sanitizeText(item.verificationHint, input.policy.textMaxChars)
      : undefined
  }));

  applyDependencies(subtasks, mode);
  const criticalPath = computeCriticalPath(subtasks);
  const parallelizableGroups = computeParallelGroups(subtasks);

  return {
    decompositionMode: mode,
    subtasks,
    criticalPath,
    parallelizableGroups
  };
}

function applyDependencies(
  subtasks: Array<{ id: string; dependsOn: string[] }>,
  mode: DecompositionMode
): void {
  if (subtasks.length === 0) {
    return;
  }
  if (mode === "linear" || subtasks.length <= 2) {
    for (let i = 1; i < subtasks.length; i += 1) {
      subtasks[i].dependsOn = [subtasks[i - 1].id];
    }
    return;
  }
  if (mode === "tree") {
    const root = subtasks[0].id;
    for (let i = 1; i < subtasks.length - 1; i += 1) {
      subtasks[i].dependsOn = [root];
    }
    subtasks[subtasks.length - 1].dependsOn = subtasks
      .slice(1, subtasks.length - 1)
      .map((step) => step.id);
    return;
  }

  // milestone mode
  for (let i = 1; i < subtasks.length; i += 1) {
    if (i % 2 === 0) {
      subtasks[i].dependsOn = [subtasks[i - 1].id];
    } else {
      subtasks[i].dependsOn = [subtasks[Math.max(0, i - 2)].id];
    }
  }
}

function computeCriticalPath(
  subtasks: Array<{
    id: string;
    dependsOn: string[];
  }>
): string[] {
  if (subtasks.length === 0) {
    return [];
  }
  const indexById = new Map<string, number>();
  subtasks.forEach((subtask, index) => {
    indexById.set(subtask.id, index);
  });

  const bestPathById = new Map<string, string[]>();
  for (const subtask of subtasks) {
    const predecessorPaths = subtask.dependsOn
      .map((depId) => bestPathById.get(depId))
      .filter((path): path is string[] => Boolean(path));
    const bestPredecessor = predecessorPaths.sort((a, b) => b.length - a.length)[0] ?? [];
    bestPathById.set(subtask.id, [...bestPredecessor, subtask.id]);
  }

  const allPaths = [...bestPathById.values()].sort((a, b) => {
    if (b.length !== a.length) {
      return b.length - a.length;
    }
    const lastA = indexById.get(a[a.length - 1] ?? "") ?? 0;
    const lastB = indexById.get(b[b.length - 1] ?? "") ?? 0;
    return lastA - lastB;
  });
  return allPaths[0] ?? subtasks.map((step) => step.id);
}

function computeParallelGroups(
  subtasks: Array<{
    id: string;
    dependsOn: string[];
  }>
): string[][] {
  const groups = new Map<string, string[]>();
  for (const subtask of subtasks) {
    const key = subtask.dependsOn.slice().sort().join("|");
    const list = groups.get(key) ?? [];
    list.push(subtask.id);
    groups.set(key, list);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

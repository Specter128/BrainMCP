import { newId } from "../utils/ids.js";
import {
  capItems,
  normalizeWhitespace,
  pickUniqueStrings,
  sanitizeText,
  type ResponsePolicy
} from "../utils/validation.js";

export type TaskType =
  | "coding"
  | "debugging"
  | "architecture"
  | "planning"
  | "analysis"
  | "mixed";

export type AnalyzeTaskInput = {
  task: string;
  constraints?: string[];
  context?: {
    domain?: string;
    environment?: string;
    existingPlan?: string;
  };
  policy: ResponsePolicy;
};

export type AnalyzeTaskOutput = {
  task: string;
  normalizedGoal: string;
  taskType: TaskType;
  constraints: string[];
  assumptionsImplicit: string[];
  unknowns: string[];
  risks: Array<{ id: string; text: string; severity: "low" | "medium" | "high" }>;
  successCriteria: string[];
  clarificationsNeeded: string[];
  suggestedWorkflow: string[];
};

const TASK_TYPE_KEYWORDS: Record<TaskType, string[]> = {
  coding: [
    "implement",
    "build",
    "code",
    "endpoint",
    "refactor",
    "typescript",
    "function",
    "server"
  ],
  debugging: ["debug", "bug", "fix", "error", "failing", "issue", "trace", "investigate"],
  architecture: [
    "architecture",
    "design",
    "system",
    "scalable",
    "modular",
    "infrastructure",
    "component"
  ],
  planning: ["plan", "roadmap", "phase", "milestone", "schedule", "sequence", "workflow"],
  analysis: ["analyze", "evaluate", "assess", "compare", "review", "research", "risk"],
  mixed: []
};

const CONSTRAINT_MARKERS = [
  "must",
  "cannot",
  "can't",
  "only",
  "without",
  "budget",
  "deadline",
  "required",
  "strict",
  "token",
  "limit",
  "no "
];

export function analyzeTask(input: AnalyzeTaskInput): AnalyzeTaskOutput {
  const normalizedTask = normalizeWhitespace(input.task);
  const taskType = detectTaskType(normalizedTask);
  const goal = extractGoal(normalizedTask, taskType, input.policy);
  const constraints = extractConstraints(normalizedTask, input.constraints, input.policy);
  const unknowns = extractUnknowns(normalizedTask, taskType, input.context, input.policy);
  const assumptionsImplicit = extractImplicitAssumptions(
    normalizedTask,
    taskType,
    input.context,
    input.policy
  );
  const risks = extractRisks(
    normalizedTask,
    constraints,
    unknowns,
    assumptionsImplicit,
    input.policy
  );
  const successCriteria = successCriteriaByType(taskType, input.policy);
  const clarificationsNeeded = capItems(
    unknowns.map((unknown) => `Clarify: ${unknown}`),
    input.policy.maxGenericItems
  );

  return {
    task: sanitizeText(normalizedTask, input.policy.textMaxChars),
    normalizedGoal: goal,
    taskType,
    constraints,
    assumptionsImplicit,
    unknowns,
    risks,
    successCriteria,
    clarificationsNeeded,
    suggestedWorkflow: workflowByType(taskType)
  };
}

export function detectTaskType(task: string): TaskType {
  const lc = task.toLowerCase();
  const scores = Object.entries(TASK_TYPE_KEYWORDS)
    .filter(([type]) => type !== "mixed")
    .map(([type, keywords]) => ({
      type: type as TaskType,
      score: keywords.reduce((acc, keyword) => acc + (lc.includes(keyword) ? 1 : 0), 0)
    }))
    .sort((a, b) => b.score - a.score);

  const best = scores[0];
  const second = scores[1];
  if (!best || best.score === 0) {
    return "mixed";
  }
  if (second && best.score - second.score <= 1 && second.score > 0) {
    return "mixed";
  }
  return best.type;
}

function extractGoal(task: string, taskType: TaskType, policy: ResponsePolicy): string {
  const firstSentence = task.split(/[.!?]/)[0] ?? task;
  const normalized = normalizeWhitespace(firstSentence);
  if (normalized.length > 15) {
    return sanitizeText(normalized, policy.textMaxChars);
  }

  const fallbackByType: Record<TaskType, string> = {
    coding: "Implement a correct and maintainable solution.",
    debugging: "Identify root cause and deliver a verified fix.",
    architecture: "Design a robust architecture with clear tradeoffs.",
    planning: "Build an actionable step-by-step execution plan.",
    analysis: "Produce a structured analysis with clear recommendations.",
    mixed: "Complete the task with verified reasoning and clear next actions."
  };
  return sanitizeText(fallbackByType[taskType], policy.textMaxChars);
}

function extractConstraints(
  task: string,
  explicitConstraints: string[] | undefined,
  policy: ResponsePolicy
): string[] {
  const discovered = task
    .split(/[.
]/)
    .map((chunk) => normalizeWhitespace(chunk))
    .filter(
      (chunk) =>
        chunk.length > 0 &&
        CONSTRAINT_MARKERS.some((marker) => chunk.toLowerCase().includes(marker))
    );

  const merged = pickUniqueStrings([...(explicitConstraints ?? []), ...discovered]).map((value) =>
    sanitizeText(value, policy.textMaxChars)
  );

  return capItems(merged, policy.maxGenericItems);
}

function extractUnknowns(
  task: string,
  taskType: TaskType,
  context: AnalyzeTaskInput["context"] | undefined,
  policy: ResponsePolicy
): string[] {
  const unknowns: string[] = [];
  if (!context?.environment) {
    unknowns.push("Target environment details are missing.");
  }
  if (!context?.domain && (taskType === "architecture" || taskType === "analysis")) {
    unknowns.push("Domain-specific requirements are not provided.");
  }
  if (!context?.existingPlan && (taskType === "planning" || taskType === "mixed")) {
    unknowns.push("No baseline plan was provided.");
  }
  if (/\?/.test(task)) {
    unknowns.push("Task contains unresolved questions.");
  }
  if (/\b(TBD|TBA|unknown|unspecified)\b/i.test(task)) {
    unknowns.push("Task includes unresolved placeholders.");
  }
  if (!/\b(success|acceptance|done|definition of done)\b/i.test(task)) {
    unknowns.push("Explicit acceptance criteria are not stated.");
  }
  return capItems(
    pickUniqueStrings(unknowns).map((value) => sanitizeText(value, policy.textMaxChars)),
    policy.maxUnknowns
  );
}

function extractImplicitAssumptions(
  task: string,
  taskType: TaskType,
  context: AnalyzeTaskInput["context"] | undefined,
  policy: ResponsePolicy
): string[] {
  const assumptions: string[] = [];
  const lc = task.toLowerCase();
  if (!context?.environment) {
    assumptions.push("Execution environment has required runtime and dependencies.");
  }
  if (lc.includes("docker")) {
    assumptions.push("Container runtime is available and image builds are permitted.");
  }
  if (lc.includes("mcp")) {
    assumptions.push("MCP clients support Streamable HTTP and tool schemas used.");
  }
  if (lc.includes("sqlite")) {
    assumptions.push("SQLite file path is writable and persistent across restarts.");
  }
  if (taskType === "debugging") {
    assumptions.push("Observed issue can be reproduced consistently.");
  }
  if (taskType === "coding") {
    assumptions.push("Existing codebase conventions should be preserved.");
  }
  return capItems(
    pickUniqueStrings(assumptions).map((value) => sanitizeText(value, policy.textMaxChars)),
    policy.maxGenericItems
  );
}

function extractRisks(
  task: string,
  constraints: string[],
  unknowns: string[],
  assumptions: string[],
  policy: ResponsePolicy
): Array<{ id: string; text: string; severity: "low" | "medium" | "high" }> {
  const riskItems: Array<{ text: string; severity: "low" | "medium" | "high" }> = [];
  const lc = task.toLowerCase();

  if (task.length > 1800) {
    riskItems.push({ text: "Task scope is large and may require phased execution.", severity: "high" });
  }
  if (unknowns.length >= 4) {
    riskItems.push({ text: "High uncertainty due to missing task details.", severity: "high" });
  }
  if (constraints.length >= 5) {
    riskItems.push({
      text: "Many constraints increase risk of conflicting requirements.",
      severity: "medium"
    });
  }
  if (assumptions.length >= 4) {
    riskItems.push({ text: "Execution depends on multiple unverified assumptions.", severity: "medium" });
  }
  if (/\b(production|security|auth|migration|payment)\b/i.test(lc)) {
    riskItems.push({
      text: "Task appears high-impact and requires stricter validation gates.",
      severity: "high"
    });
  }
  if (/\b(deadline|urgent|asap|quickly)\b/i.test(lc)) {
    riskItems.push({
      text: "Time pressure may reduce verification depth and increase defects.",
      severity: "medium"
    });
  }
  if (riskItems.length === 0) {
    riskItems.push({ text: "No critical risks detected from current input.", severity: "low" });
  }

  return capItems(
    pickUniqueStrings(riskItems.map((item) => `${item.severity}|${item.text}`)).map((value) => {
      const [severityRaw, text] = value.split("|");
      const severity = (severityRaw as "low" | "medium" | "high") ?? "low";
      return {
        id: newId("risk"),
        text: sanitizeText(text ?? "", policy.textMaxChars),
        severity
      };
    }),
    policy.maxRisks
  );
}

function successCriteriaByType(taskType: TaskType, policy: ResponsePolicy): string[] {
  const criteriaByType: Record<TaskType, string[]> = {
    coding: [
      "Implementation is complete and aligned with requirements.",
      "Changes are logically validated and externally testable.",
      "Outputs and interfaces remain stable and deterministic."
    ],
    debugging: [
      "Root cause is identified and documented.",
      "Fix addresses the root cause without regressions.",
      "Verification evidence confirms issue is resolved."
    ],
    architecture: [
      "Architecture decisions cover constraints and dependencies.",
      "Tradeoffs and risks are explicitly documented.",
      "Plan is decomposed into executable, verifiable steps."
    ],
    planning: [
      "Plan has clear sequencing, dependencies, and checkpoints.",
      "High-risk areas include explicit verification gates.",
      "Next actions are unambiguous and immediately executable."
    ],
    analysis: [
      "Conclusions are consistent with stated evidence and assumptions.",
      "Key risks and unknowns are explicitly tracked.",
      "Recommendations are actionable and prioritized."
    ],
    mixed: [
      "Task is decomposed into clear subtasks and dependencies.",
      "Assumptions and risks are tracked and reviewed.",
      "Next best action is selected with clear rationale."
    ]
  };
  return capItems(
    criteriaByType[taskType].map((item) => sanitizeText(item, policy.textMaxChars)),
    policy.maxSuccessCriteria
  );
}

function workflowByType(taskType: TaskType): string[] {
  const base = ["decompose_task", "build_plan", "list_assumptions", "consistency_check"];
  if (taskType === "debugging") {
    return [...base, "critic_review", "next_best_action"];
  }
  if (taskType === "planning" || taskType === "architecture") {
    return [...base, "critic_review", "compact_reasoning_state"];
  }
  return [...base, "next_best_action"];
}

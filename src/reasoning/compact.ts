import type { AssumptionRecord } from "../storage/repositories/assumptions.js";
import type { DecisionLogRecord } from "../storage/repositories/decisionLogs.js";
import type { PlanStepRecord } from "../storage/repositories/plans.js";
import { estimateTokensFromText } from "../utils/tokenEstimate.js";
import { capItems, sanitizeText, type ResponsePolicy } from "../utils/validation.js";

export type CompactSection =
  | "goal"
  | "constraints"
  | "open-risks"
  | "assumptions"
  | "current-plan"
  | "recent-results"
  | "decisions";

export type CompactStateInput = {
  targetTokens?: number;
  preserve?: CompactSection[];
  goal?: string;
  constraints?: string[];
  planSteps: PlanStepRecord[];
  assumptions: AssumptionRecord[];
  decisionLogs: DecisionLogRecord[];
  policy: ResponsePolicy;
};

export type CompactStateOutput = {
  compactState: string;
  beforeEstimatedTokens: number;
  afterEstimatedTokens: number;
  preservedSections: string[];
  droppedOrCompressedSections: string[];
};

type SectionState = {
  key: string;
  label: string;
  text: string;
  priority: number;
};

export function compactReasoningState(input: CompactStateInput): CompactStateOutput {
  const targetTokens = resolveTargetTokens(input.targetTokens, input.policy);
  const preserve = new Set(input.preserve ?? []);
  const sections = buildSections(input);
  const beforeState = sectionsToText(sections);
  const beforeEstimatedTokens = estimateTokensFromText(beforeState);

  const droppedOrCompressed = new Set<string>();
  let working = [...sections];
  let compactedText = sectionsToText(working);
  let targetChars = targetTokens * 4;

  while (compactedText.length > targetChars) {
    const compressible = pickCompressibleSection(working, preserve);
    if (compressible) {
      const index = working.findIndex((item) => item.key === compressible.key);
      const trimmed = trimSectionText(compressible.text);
      working[index] = { ...compressible, text: trimmed };
      droppedOrCompressed.add(compressible.key);
      compactedText = sectionsToText(working);
      continue;
    }

    const droppable = pickDroppableSection(working, preserve);
    if (!droppable) {
      targetChars = Math.floor(targetChars * 1.1);
      break;
    }
    const index = working.findIndex((item) => item.key === droppable.key);
    working[index] = { ...droppable, text: "" };
    droppedOrCompressed.add(droppable.key);
    compactedText = sectionsToText(working);
  }

  const compactState = sanitizeText(compactedText, Math.max(400, targetChars));
  return {
    compactState,
    beforeEstimatedTokens,
    afterEstimatedTokens: estimateTokensFromText(compactState),
    preservedSections: capItems([...preserve], 7),
    droppedOrCompressedSections: capItems([...droppedOrCompressed], 7)
  };
}

function resolveTargetTokens(targetTokens: number | undefined, policy: ResponsePolicy): number {
  if (targetTokens !== undefined) {
    return targetTokens;
  }
  if (policy.mode === "small") {
    return 300;
  }
  if (policy.mode === "deep") {
    return 1400;
  }
  return 700;
}

function buildSections(input: CompactStateInput): SectionState[] {
  const decisionLogs = input.decisionLogs;
  const openRisks = decisionLogs
    .filter((log) => log.kind === "risk")
    .map((log) => log.summary)
    .concat(
      input.assumptions
        .filter((item) => item.status === "risky" || item.status === "contradicted")
        .map((item) => item.text)
    );

  const verifiedCount = input.assumptions.filter((item) => item.status === "verified").length;
  const unverifiedCount = input.assumptions.length - verifiedCount;
  const nextPendingStep = input.planSteps.find((step) => step.status === "pending");
  const nextImmediateActions = nextPendingStep
    ? [`Execute ${nextPendingStep.stepId}: ${nextPendingStep.title}`]
    : ["Run next_best_action to determine follow-up."];

  const currentPlanStatus = summarizePlanStatus(input.planSteps);
  const recentResults = decisionLogs
    .filter((log) => log.kind === "result")
    .slice(0, 5)
    .map((log) => log.summary);
  const recentDecisions = decisionLogs
    .filter((log) => log.kind === "decision" || log.kind === "checkpoint")
    .slice(0, 6)
    .map((log) => `${log.kind}:${log.summary}`);

  return [
    {
      key: "goal",
      label: "Goal",
      text: input.goal ? line(input.goal) : line("N/A"),
      priority: 1
    },
    {
      key: "constraints",
      label: "Constraints",
      text: lines(input.constraints ?? [], 6),
      priority: 2
    },
    {
      key: "current-plan",
      label: "Current Plan Status",
      text: lines([currentPlanStatus], 1),
      priority: 1
    },
    {
      key: "open-risks",
      label: "Open Risks",
      text: lines(openRisks, 6),
      priority: 2
    },
    {
      key: "assumptions",
      label: "Verified/Unverified Assumptions",
      text: lines([`verified=${verifiedCount}`, `unverified=${unverifiedCount}`], 2),
      priority: 2
    },
    {
      key: "recent-results",
      label: "Last Results",
      text: lines(recentResults, 4),
      priority: 3
    },
    {
      key: "decisions",
      label: "Decisions",
      text: lines(recentDecisions, 4),
      priority: 3
    },
    {
      key: "next-actions",
      label: "Next Immediate Actions",
      text: lines(nextImmediateActions, 3),
      priority: 1
    }
  ];
}

function summarizePlanStatus(steps: PlanStepRecord[]): string {
  const counts = {
    pending: 0,
    in_progress: 0,
    blocked: 0,
    done: 0,
    skipped: 0
  };
  for (const step of steps) {
    counts[step.status] += 1;
  }
  return `pending=${counts.pending}, in_progress=${counts.in_progress}, blocked=${counts.blocked}, done=${counts.done}, skipped=${counts.skipped}`;
}

function pickCompressibleSection(
  sections: SectionState[],
  preserve: Set<string>
): SectionState | undefined {
  return [...sections]
    .filter((section) => section.text.length > 80)
    .filter((section) => !preserve.has(section.key) || section.text.length > 140)
    .sort((a, b) => b.text.length - a.text.length)[0];
}

function pickDroppableSection(sections: SectionState[], preserve: Set<string>): SectionState | undefined {
  return [...sections]
    .filter((section) => section.text.length > 0)
    .filter((section) => !preserve.has(section.key) && section.key !== "next-actions")
    .sort((a, b) => b.priority - a.priority || b.text.length - a.text.length)[0];
}

function trimSectionText(text: string): string {
  if (text.length <= 80) {
    return text;
  }
  const nextLength = Math.max(60, Math.floor(text.length * 0.78));
  return `${text.slice(0, nextLength)}...`;
}

function sectionsToText(sections: SectionState[]): string {
  return sections
    .filter((section) => section.text.length > 0)
    .map((section) => `${section.label}: ${section.text}`)
    .join(" | ");
}

function line(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function lines(values: string[], cap: number): string {
  const sliced = capItems(
    values.map((value) => line(value)).filter((value) => value.length > 0),
    cap
  );
  return sliced.length === 0 ? "none" : sliced.join(" ; ");
}

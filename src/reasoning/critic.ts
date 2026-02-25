import { capItems, sanitizeText, type ResponsePolicy } from "../utils/validation.js";

export type CriticCategory =
  | "correctness"
  | "completeness"
  | "risk"
  | "testability"
  | "simplicity"
  | "maintainability";

export type CriticInput = {
  subject: {
    type: "plan" | "proposal" | "draft-answer" | "approach" | "decision-set";
    text?: string;
    structured?: unknown;
  };
  rubric?: Partial<Record<CriticCategory, number>>;
  style?: "strict" | "balanced" | "coaching";
  policy: ResponsePolicy;
};

export type CriticOutput = {
  scores: {
    correctness: number;
    completeness: number;
    risk: number;
    testability: number;
    simplicity: number;
    maintainability: number;
    weightedTotal: number;
  };
  findings: Array<{
    category: CriticCategory;
    severity: "low" | "medium" | "high";
    issue: string;
    recommendation: string;
  }>;
  strengths: string[];
  weaknesses: string[];
  verdict: "approve" | "revise" | "reject";
};

const DEFAULT_WEIGHTS: Record<CriticCategory, number> = {
  correctness: 5,
  completeness: 4,
  risk: 4,
  testability: 3,
  simplicity: 2,
  maintainability: 3
};

export function runCriticReview(input: CriticInput): CriticOutput {
  const sourceText = sanitizeText(
    input.subject.text ?? JSON.stringify(input.subject.structured ?? {}),
    input.policy.mode === "small" ? 1500 : 3500
  );
  const style = input.style ?? "balanced";

  const scores = {
    correctness: roundOne(scoreCorrectness(sourceText)),
    completeness: roundOne(scoreCompleteness(sourceText)),
    risk: roundOne(scoreRisk(sourceText)),
    testability: roundOne(scoreTestability(sourceText)),
    simplicity: roundOne(scoreSimplicity(sourceText)),
    maintainability: roundOne(scoreMaintainability(sourceText))
  };

  const weights = resolveWeights(input.rubric);
  const weightedTotal = roundOne(
    (scores.correctness * weights.correctness +
      scores.completeness * weights.completeness +
      scores.risk * weights.risk +
      scores.testability * weights.testability +
      scores.simplicity * weights.simplicity +
      scores.maintainability * weights.maintainability) /
      sumWeights(weights)
  );

  const findings = capItems(
    buildFindings(scores, style, input.policy),
    Math.max(4, input.policy.maxFindings)
  );
  const strengths = capItems(
    categoryLabels()
      .filter((category) => scores[category] >= 8)
      .map((category) =>
        sanitizeText(`${capitalize(category)} quality is strong.`, input.policy.textMaxChars)
      ),
    input.policy.maxGenericItems
  );
  const weaknesses = capItems(
    categoryLabels()
      .filter((category) => scores[category] <= 6)
      .map((category) =>
        sanitizeText(`${capitalize(category)} quality needs improvement.`, input.policy.textMaxChars)
      ),
    input.policy.maxGenericItems
  );

  const verdict = resolveVerdict(scores, weightedTotal, findings);

  return {
    scores: {
      ...scores,
      weightedTotal
    },
    findings,
    strengths,
    weaknesses,
    verdict
  };
}

function resolveWeights(rubric?: Partial<Record<CriticCategory, number>>): Record<CriticCategory, number> {
  const resolved: Record<CriticCategory, number> = { ...DEFAULT_WEIGHTS };
  if (!rubric) {
    return resolved;
  }
  for (const key of categoryLabels()) {
    const value = rubric[key];
    if (value !== undefined) {
      resolved[key] = clamp(value, 0, 5);
    }
  }
  if (sumWeights(resolved) === 0) {
    return { ...DEFAULT_WEIGHTS };
  }
  return resolved;
}

function buildFindings(
  scores: Omit<CriticOutput["scores"], "weightedTotal">,
  style: "strict" | "balanced" | "coaching",
  policy: ResponsePolicy
): CriticOutput["findings"] {
  const findings: CriticOutput["findings"] = [];
  for (const category of categoryLabels()) {
    const score = scores[category];
    if (score >= 7.5) {
      continue;
    }
    const severity = score <= 4.5 ? "high" : score <= 6 ? "medium" : "low";
    findings.push({
      category,
      severity,
      issue: styleIssueText(category, severity, style, policy),
      recommendation: styleRecommendationText(category, severity, style, policy)
    });
  }
  return findings;
}

function resolveVerdict(
  scores: Omit<CriticOutput["scores"], "weightedTotal">,
  weightedTotal: number,
  findings: CriticOutput["findings"]
): CriticOutput["verdict"] {
  const highCorrectnessFailure = scores.correctness < 5 || scores.completeness < 5;
  const hardBlockers = findings.some(
    (item) =>
      item.severity === "high" &&
      (item.category === "correctness" ||
        item.category === "completeness" ||
        item.category === "risk")
  );
  if (highCorrectnessFailure || hardBlockers) {
    return "reject";
  }
  if (weightedTotal >= 7.5 && !findings.some((item) => item.severity === "high")) {
    return "approve";
  }
  return "revise";
}

function scoreCorrectness(text: string): number {
  if (!text) {
    return 2;
  }
  let score = 6.5;
  if (/\b(verified|evidence|deterministic|consistent|validated)\b/i.test(text)) {
    score += 2;
  }
  if (/\b(maybe|guess|probably|unclear|unsure)\b/i.test(text)) {
    score -= 2;
  }
  if (text.length < 120) {
    score -= 1.5;
  }
  if (/\b(contradict|inconsistent)\b/i.test(text)) {
    score -= 2;
  }
  return clamp(score, 0, 10);
}

function scoreCompleteness(text: string): number {
  if (!text) {
    return 1.5;
  }
  const signals = ["goal", "constraint", "assumption", "risk", "verify", "next action", "plan step"];
  const count = signals.reduce((acc, term) => acc + (text.toLowerCase().includes(term) ? 1 : 0), 0);
  let score = 2 + count * 1.1;
  if (text.length > 800) {
    score += 1;
  }
  if (text.length < 100) {
    score -= 1.5;
  }
  return clamp(score, 0, 10);
}

function scoreRisk(text: string): number {
  let score = 4;
  if (/\b(risk|blocker|mitigation|fallback|failure)\b/i.test(text)) {
    score += 3;
  }
  if (/\b(high-risk|critical|safety)\b/i.test(text)) {
    score += 1;
  }
  if (/\b(ignore risk|skip validation)\b/i.test(text)) {
    score -= 3;
  }
  return clamp(score, 0, 10);
}

function scoreTestability(text: string): number {
  let score = 3;
  if (/\b(test|verify|assert|evidence|checkpoint|acceptance)\b/i.test(text)) {
    score += 4;
  }
  if (/\b(manual|review|logic-check)\b/i.test(text)) {
    score += 1.5;
  }
  if (!/\b(test|verify|check)\b/i.test(text)) {
    score -= 2;
  }
  return clamp(score, 0, 10);
}

function scoreSimplicity(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  const sentences = text.split(/[.!?]/).filter((s) => s.trim().length > 0).length || 1;
  const avgSentenceWords = words / sentences;
  let score = 8;
  if (avgSentenceWords > 28) {
    score -= 3;
  } else if (avgSentenceWords > 20) {
    score -= 1.5;
  }
  if (words > 900) {
    score -= 2;
  }
  if (/\b(simple|minimal|focused)\b/i.test(text)) {
    score += 1;
  }
  return clamp(score, 0, 10);
}

function scoreMaintainability(text: string): number {
  let score = 4;
  if (/\b(modular|schema|stable|typed|repository|migration)\b/i.test(text)) {
    score += 3;
  }
  if (/\b(document|readme|test)\b/i.test(text)) {
    score += 2;
  }
  if (/\b(hack|temporary|quick fix)\b/i.test(text)) {
    score -= 2;
  }
  return clamp(score, 0, 10);
}

function styleIssueText(
  category: CriticCategory,
  severity: "low" | "medium" | "high",
  style: "strict" | "balanced" | "coaching",
  policy: ResponsePolicy
): string {
  const prefix =
    style === "strict" ? "Defect:" : style === "coaching" ? "Improve:" : "Issue:";
  return sanitizeText(`${prefix} ${capitalize(category)} scored ${severity}.`, policy.textMaxChars);
}

function styleRecommendationText(
  category: CriticCategory,
  severity: "low" | "medium" | "high",
  style: "strict" | "balanced" | "coaching",
  policy: ResponsePolicy
): string {
  const actionByCategory: Record<CriticCategory, string> = {
    correctness: "Add objective evidence and remove ambiguous claims.",
    completeness: "Cover missing sections: goal, constraints, assumptions, and verification.",
    risk: "Add explicit mitigations and failure handling checkpoints.",
    testability: "Define concrete verification checks and acceptance criteria.",
    simplicity: "Reduce scope per step and shorten complex statements.",
    maintainability: "Improve modularity, schema stability, and test coverage."
  };
  const suffix =
    style === "coaching"
      ? " Focus on one high-impact fix first."
      : severity === "high"
        ? " Apply before approval."
        : "";
  return sanitizeText(`${actionByCategory[category]}${suffix}`, policy.textMaxChars);
}

function categoryLabels(): CriticCategory[] {
  return [
    "correctness",
    "completeness",
    "risk",
    "testability",
    "simplicity",
    "maintainability"
  ];
}

function sumWeights(weights: Record<CriticCategory, number>): number {
  return weights.correctness +
    weights.completeness +
    weights.risk +
    weights.testability +
    weights.simplicity +
    weights.maintainability;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundOne(value: number): number {
  return Math.round(value * 10) / 10;
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

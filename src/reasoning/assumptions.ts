import { newId, stableHash } from "../utils/ids.js";
import {
  capItems,
  normalizeWhitespace,
  pickUniqueStrings,
  sanitizeText,
  type ResponsePolicy
} from "../utils/validation.js";
import type { AssumptionCategory, AssumptionRisk, AssumptionStatus } from "../storage/repositories/assumptions.js";

export type ExtractAssumptionsInput = {
  sourceText?: string;
  includeImplicit?: boolean;
  planTitles?: string[];
  decisionSummaries?: string[];
  policy: ResponsePolicy;
};

export type ExtractedAssumption = {
  assumptionId: string;
  text: string;
  normalizedHash: string;
  type: "explicit" | "implicit";
  category: AssumptionCategory;
  status: "unverified";
  risk: AssumptionRisk;
};

export type AssumptionCheckInputItem = {
  assumptionId?: string;
  text: string;
  category?: AssumptionCategory;
  risk?: AssumptionRisk;
  evidenceAvailable?: string[];
  statusHint?: "verified" | "unverified" | "risky";
  sessionConflicts?: boolean;
};

export type AssumptionCheckResultItem = {
  assumptionId?: string;
  text: string;
  status: AssumptionStatus;
  confidence: "low" | "medium" | "high";
  evidenceNeeded: string[];
  impactIfWrong: string;
  recommendedAction: string;
};

const EXPLICIT_PATTERNS = [
  /\bassume(?:d|s|ing)?\b/i,
  /\brequires?\b/i,
  /\bdepends on\b/i,
  /\bexpects?\b/i,
  /\bmust have\b/i
];

export function extractAssumptions(input: ExtractAssumptionsInput): ExtractedAssumption[] {
  const mergedText = normalizeWhitespace(
    [input.sourceText ?? "", ...(input.planTitles ?? []), ...(input.decisionSummaries ?? [])]
      .join(". ")
      .trim()
  );
  if (!mergedText) {
    return [];
  }

  const sentences = mergedText
    .split(/[.
!?]/)
    .map((sentence) => normalizeWhitespace(sentence))
    .filter((sentence) => sentence.length > 0);

  const explicit = sentences.filter((sentence) =>
    EXPLICIT_PATTERNS.some((pattern) => pattern.test(sentence))
  );

  const implicit =
    input.includeImplicit === false
      ? []
      : deriveImplicitAssumptions(sentences, input.policy).map((item) => item.text);

  const combined = pickUniqueStrings([...explicit, ...implicit]);
  const mapped = combined.map((text) => {
    const normalized = normalizeAssumptionText(text);
    const category = classifyAssumptionCategory(text);
    const risk = classifyAssumptionRisk(text, category);
    const isExplicit = explicit.includes(text);
    return {
      assumptionId: newId("assumption"),
      text: sanitizeText(text, input.policy.textMaxChars),
      normalizedHash: stableHash(normalized),
      type: isExplicit ? ("explicit" as const) : ("implicit" as const),
      category,
      status: "unverified" as const,
      risk
    };
  });

  return capItems(mapped, input.policy.maxAssumptions);
}

export function normalizeAssumptionText(text: string): string {
  return normalizeWhitespace(text.toLowerCase().replace(/[^\w\s]/g, ""));
}

export function classifyAssumptionCategory(text: string): AssumptionCategory {
  const lc = text.toLowerCase();
  if (/\b(api|library|sdk|runtime|typescript|docker|sqlite|server|port)\b/.test(lc)) {
    return "technical";
  }
  if (/\b(vps|ubuntu|oracle|host|network|environment|filesystem)\b/.test(lc)) {
    return "environment";
  }
  if (/\b(data|schema|json|payload|input|output|format)\b/.test(lc)) {
    return "data";
  }
  if (/\b(depends|dependency|external|service|integration|mcp)\b/.test(lc)) {
    return "dependency";
  }
  if (/\b(process|workflow|phase|plan|review|verify)\b/.test(lc)) {
    return "process";
  }
  return "user-intent";
}

export function classifyAssumptionRisk(
  text: string,
  category: AssumptionCategory = classifyAssumptionCategory(text)
): AssumptionRisk {
  const lc = text.toLowerCase();
  let score = 0;
  if (category === "dependency" || category === "environment") {
    score += 2;
  }
  if (/\b(production|security|authentication|critical|must)\b/.test(lc)) {
    score += 2;
  }
  if (/\b(maybe|likely|probably|unknown)\b/.test(lc)) {
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

export function checkAssumptions(
  input: {
    checks: AssumptionCheckInputItem[];
    strictness: "standard" | "strict";
    policy: ResponsePolicy;
  } & Partial<{ defaultCategory: AssumptionCategory; defaultRisk: AssumptionRisk }>
): {
  results: AssumptionCheckResultItem[];
  summary: {
    verified: number;
    unverified: number;
    risky: number;
    contradicted: number;
  };
} {
  const results = capItems(
    input.checks.map((check) => classifyCheck(check, input.strictness, input.policy)),
    input.policy.maxAssumptions
  );

  const summary = {
    verified: results.filter((item) => item.status === "verified").length,
    unverified: results.filter((item) => item.status === "unverified").length,
    risky: results.filter((item) => item.status === "risky").length,
    contradicted: results.filter((item) => item.status === "contradicted").length
  };
  return { results, summary };
}

function deriveImplicitAssumptions(
  sentences: string[],
  policy: ResponsePolicy
): Array<{ text: string }> {
  const derived: string[] = [];
  const merged = sentences.join(" ").toLowerCase();
  if (merged.includes("docker")) {
    derived.push("Docker runtime is available in target environment.");
  }
  if (merged.includes("sqlite")) {
    derived.push("SQLite storage path has persistent write access.");
  }
  if (merged.includes("mcp")) {
    derived.push("Connected clients can consume JSON-only MCP tool outputs.");
  }
  if (merged.includes("auth") || merged.includes("token")) {
    derived.push("Bearer token distribution and rotation are handled securely.");
  }
  if (!/\b(test|verify|validation)\b/.test(merged)) {
    derived.push("External verification tooling is available for downstream checks.");
  }

  return capItems(
    pickUniqueStrings(derived).map((text) => ({ text: sanitizeText(text, policy.textMaxChars) })),
    policy.maxAssumptions
  );
}

function classifyCheck(
  check: AssumptionCheckInputItem,
  strictness: "standard" | "strict",
  policy: ResponsePolicy
): AssumptionCheckResultItem {
  const evidence = check.evidenceAvailable ?? [];
  const lcEvidence = evidence.map((item) => item.toLowerCase());
  const hasContradiction =
    check.sessionConflicts === true ||
    lcEvidence.some((item) => /\b(contradict|failed|broken|mismatch|invalid)\b/.test(item));
  const hasEvidence = evidence.length > 0;
  const risk = check.risk ?? classifyAssumptionRisk(check.text, check.category);

  let status: AssumptionStatus = "unverified";
  let confidence: "low" | "medium" | "high" = "low";

  if (hasContradiction) {
    status = "contradicted";
    confidence = hasEvidence ? "high" : "medium";
  } else if (check.statusHint === "verified" && hasEvidence) {
    status = "verified";
    confidence = evidence.length >= 2 ? "high" : "medium";
  } else if (hasEvidence && risk !== "high" && check.statusHint !== "risky") {
    status = "verified";
    confidence = evidence.length >= 2 ? "high" : "medium";
  } else if (strictness === "strict" && !hasEvidence) {
    status = "risky";
    confidence = "low";
  } else if (risk === "high" || check.statusHint === "risky") {
    status = hasEvidence ? "unverified" : "risky";
    confidence = hasEvidence ? "medium" : "low";
  } else {
    status = "unverified";
    confidence = hasEvidence ? "medium" : "low";
  }

  const evidenceNeeded = defaultEvidenceNeeded(check.category, status, policy);
  return {
    assumptionId: check.assumptionId,
    text: sanitizeText(check.text, policy.textMaxChars),
    status,
    confidence,
    evidenceNeeded,
    impactIfWrong: impactIfWrong(check.category, risk, policy),
    recommendedAction: recommendedAction(status, check.category, policy)
  };
}

function defaultEvidenceNeeded(
  category: AssumptionCategory | undefined,
  status: AssumptionStatus,
  policy: ResponsePolicy
): string[] {
  const byCategory: Record<AssumptionCategory, string[]> = {
    technical: ["Config snapshot", "Compatibility confirmation"],
    environment: ["Runtime environment check", "Filesystem/network availability proof"],
    data: ["Schema validation sample", "Representative payload sample"],
    dependency: ["Dependency version confirmation", "Integration contract validation"],
    process: ["Workflow checkpoint record", "Ownership confirmation"],
    "user-intent": ["Requirement clarification note", "Acceptance criteria confirmation"]
  };
  const base = byCategory[category ?? "user-intent"];
  if (status === "verified") {
    return capItems([base[0]], 1).map((text) => sanitizeText(text, policy.textMaxChars));
  }
  return capItems(base, 2).map((text) => sanitizeText(text, policy.textMaxChars));
}

function impactIfWrong(
  category: AssumptionCategory | undefined,
  risk: AssumptionRisk,
  policy: ResponsePolicy
): string {
  const categoryLabel = category ?? "user-intent";
  const suffix = risk === "high" ? "could block delivery or cause incorrect outcomes." : "may cause rework.";
  return sanitizeText(`${categoryLabel} assumption failure ${suffix}`, policy.textMaxChars);
}

function recommendedAction(
  status: AssumptionStatus,
  category: AssumptionCategory | undefined,
  policy: ResponsePolicy
): string {
  if (status === "contradicted") {
    return sanitizeText("Revise plan and replace contradicted assumption immediately.", policy.textMaxChars);
  }
  if (status === "risky") {
    return sanitizeText("Gather evidence before executing dependent steps.", policy.textMaxChars);
  }
  if (status === "unverified") {
    return sanitizeText(
      `Verify ${category ?? "user-intent"} assumption at next checkpoint.`,
      policy.textMaxChars
    );
  }
  return sanitizeText("Keep monitoring evidence; proceed with planned execution.", policy.textMaxChars);
}

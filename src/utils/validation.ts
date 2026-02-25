import { truncateText } from "./truncation.js";

export type ClientMode = "small" | "balanced" | "deep";

export type ClientProfile = {
  name?: string;
  maxContextTokens?: number;
  mode?: ClientMode;
};

export type ResponsePolicy = {
  mode: ClientMode;
  maxGenericItems: number;
  maxSubtasks: number;
  maxFindings: number;
  maxAlternatives: number;
  maxDecisionEntries: number;
  maxAssumptions: number;
  maxRisks: number;
  maxUnknowns: number;
  maxSuccessCriteria: number;
  maxActionSuggestions: number;
  textMaxChars: number;
  shortTextMaxChars: number;
};

export const INPUT_LIMITS = {
  maxTaskChars: 12000,
  maxSummaryChars: 1000,
  maxDetailChars: 4000,
  maxDraftItems: 120,
  maxArrayInput: 100
} as const;

const POLICY_BY_MODE: Record<ClientMode, Omit<ResponsePolicy, "mode">> = {
  small: {
    maxGenericItems: 12,
    maxSubtasks: 8,
    maxFindings: 6,
    maxAlternatives: 2,
    maxDecisionEntries: 20,
    maxAssumptions: 12,
    maxRisks: 8,
    maxUnknowns: 10,
    maxSuccessCriteria: 8,
    maxActionSuggestions: 3,
    textMaxChars: 240,
    shortTextMaxChars: 120
  },
  balanced: {
    maxGenericItems: 16,
    maxSubtasks: 12,
    maxFindings: 10,
    maxAlternatives: 3,
    maxDecisionEntries: 40,
    maxAssumptions: 20,
    maxRisks: 12,
    maxUnknowns: 12,
    maxSuccessCriteria: 10,
    maxActionSuggestions: 4,
    textMaxChars: 480,
    shortTextMaxChars: 200
  },
  deep: {
    maxGenericItems: 24,
    maxSubtasks: 20,
    maxFindings: 16,
    maxAlternatives: 3,
    maxDecisionEntries: 80,
    maxAssumptions: 40,
    maxRisks: 18,
    maxUnknowns: 18,
    maxSuccessCriteria: 14,
    maxActionSuggestions: 5,
    textMaxChars: 900,
    shortTextMaxChars: 320
  }
};

export function resolveClientMode(clientProfile?: ClientProfile): ClientMode {
  if (clientProfile?.mode === "small" || (clientProfile?.maxContextTokens ?? Infinity) <= 2000) {
    return "small";
  }
  if (clientProfile?.mode === "deep" || (clientProfile?.maxContextTokens ?? 0) >= 16000) {
    return "deep";
  }
  return "balanced";
}

export function getResponsePolicy(clientProfile?: ClientProfile): ResponsePolicy {
  const mode = resolveClientMode(clientProfile);
  return { mode, ...POLICY_BY_MODE[mode] };
}

export function capItems<T>(items: T[], maxItems: number): T[] {
  if (maxItems < 0) {
    return [];
  }
  return items.slice(0, maxItems);
}

export function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

export function sanitizeText(input: string, maxChars: number): string {
  return truncateText(normalizeWhitespace(input), maxChars);
}

export function sanitizeTextList(values: string[] | undefined, maxItems: number, maxChars: number): string[] {
  if (!values?.length) {
    return [];
  }
  return capItems(
    values.map((value) => sanitizeText(value, maxChars)).filter((value) => value.length > 0),
    maxItems
  );
}

export function pickUniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(value);
  }
  return result;
}

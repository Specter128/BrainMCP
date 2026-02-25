export function estimateTokensFromText(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function estimateTokensFromJson(value: unknown): number {
  return estimateTokensFromText(JSON.stringify(value));
}

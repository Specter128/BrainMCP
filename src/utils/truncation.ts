export function truncateText(input: string, maxChars: number): string {
  if (maxChars <= 0) {
    return "";
  }
  if (input.length <= maxChars) {
    return input;
  }
  if (maxChars <= 3) {
    return input.slice(0, maxChars);
  }
  return `${input.slice(0, maxChars - 3)}...`;
}

export function truncateArray<T>(items: T[], maxItems: number): { items: T[]; truncated: boolean } {
  if (maxItems < 0) {
    return { items: [], truncated: items.length > 0 };
  }
  if (items.length <= maxItems) {
    return { items, truncated: false };
  }
  return { items: items.slice(0, maxItems), truncated: true };
}

export function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function compactJson(value: unknown): string {
  return JSON.stringify(value);
}

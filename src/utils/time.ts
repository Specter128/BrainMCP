export function nowIso(): string {
  return new Date().toISOString();
}

export function secondsSince(startedAtMs: number): number {
  return Math.floor((Date.now() - startedAtMs) / 1000);
}

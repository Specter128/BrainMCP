import path from "node:path";

export function resolveSafePath(baseDir: string, candidateRelativePath: string): string {
  const safeBase = path.resolve(baseDir);
  const resolved = path.resolve(safeBase, candidateRelativePath);
  const withSep = `${safeBase}${path.sep}`;
  if (!(resolved === safeBase || resolved.startsWith(withSep))) {
    throw new Error("Path traversal blocked.");
  }
  return resolved;
}

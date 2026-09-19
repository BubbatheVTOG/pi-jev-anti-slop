import { realpathSync, statSync } from "node:fs";
import { basename, relative, resolve, sep } from "node:path";

const SENSITIVE_NAMES = new Set([
  ".env",
  ".npmrc",
  ".pypirc",
  "auth.json",
  "credentials",
  "credentials.json",
  "id_rsa",
  "id_ed25519",
]);

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

function isSensitive(file: string): boolean {
  const name = basename(file).toLowerCase();
  return (
    SENSITIVE_NAMES.has(name) ||
    name.startsWith(".env.") ||
    name.endsWith(".pem") ||
    name.endsWith(".key")
  );
}

/** Resolve an existing review target without allowing project escape or secrets. */
export function resolveSafeReviewPath(
  cwd: string,
  input: string,
  expected: "file" | "directory",
): string {
  const root = realpathSync(cwd);
  const target = realpathSync(resolve(cwd, input));
  if (!isWithin(root, target)) {
    throw new Error(`review target is outside the project root: ${target}`);
  }
  if (expected === "file" && !statSync(target).isFile()) {
    throw new Error(`review target is not a regular file: ${target}`);
  }
  if (expected === "directory" && !statSync(target).isDirectory()) {
    throw new Error(`review target is not a directory: ${target}`);
  }
  if (expected === "file" && isSensitive(target)) {
    throw new Error(`refusing to send a potentially sensitive file: ${target}`);
  }
  return target;
}

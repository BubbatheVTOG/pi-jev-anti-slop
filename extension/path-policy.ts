import { realpathSync, statSync } from "node:fs";
import { basename, relative, resolve, sep } from "node:path";

const REDACTED = "[REDACTED]";

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

const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|sk-[A-Za-z0-9_-]{20,})\b/g,
];

const SECRET_ASSIGNMENT =
  /(\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\b\s*[:=]\s*["'`])([^"'`\n]{8,})(["'`])/gi;

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

/** Redact high-confidence credential shapes before code leaves the machine. */
export function redactLikelySecrets(code: string): {
  code: string;
  redacted: boolean;
} {
  let safe = code;
  for (const pattern of SECRET_PATTERNS) safe = safe.replace(pattern, REDACTED);
  safe = safe.replace(
    SECRET_ASSIGNMENT,
    (_match, prefix: string, _value: string, suffix: string) =>
      `${prefix}${REDACTED}${suffix}`,
  );
  return { code: safe, redacted: safe !== code };
}

export type SafeReviewPath =
  | { ok: true; path: string }
  | { ok: false; error: string };

/** Resolve a review target without throwing, project escape, or secret files. */
export function resolveSafeReviewPath(
  cwd: string,
  input: string,
  expected: "file" | "directory" | "either",
): SafeReviewPath {
  try {
    const root = realpathSync(cwd);
    const target = realpathSync(resolve(cwd, input));
    if (!isWithin(root, target)) {
      return { ok: false, error: "review target is outside the project root" };
    }
    const stat = statSync(target);
    if (expected === "file" && !stat.isFile()) {
      return { ok: false, error: "review target is not a regular file" };
    }
    if (expected === "directory" && !stat.isDirectory()) {
      return { ok: false, error: "review target is not a directory" };
    }
    if (expected === "either" && !stat.isFile() && !stat.isDirectory()) {
      return { ok: false, error: "review target is not a file or directory" };
    }
    if (stat.isFile() && isSensitive(target)) {
      return { ok: false, error: "refusing to send a potentially sensitive file" };
    }
    return { ok: true, path: target };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `could not resolve review target: ${message}` };
  }
}

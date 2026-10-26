export interface RedactionOptions {
  redactEmails: boolean;
}

export interface RedactionResult {
  text: string;
  /** Count of redactions per kind. Never contains the redacted values. */
  report: Record<string, number>;
}

interface RedactionRule {
  kind: string;
  pattern: RegExp;
  /** Returns the replacement, or null to keep the original match. */
  replace: (match: string, groups: string[]) => string | null;
}

const PLACEHOLDER_SECRET =
  /^(?:\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|<[^>]*>|\*+|x{3,}|\.{3,}|password|passwd|pass|secret|changeme|change_me|change-me|your[-_]?\w*|example\w*|placeholder\w*|dummy\w*|redacted\w*)$/i;

const CODE_REFERENCE =
  /^(?:process\.env|import\.meta\.env|os\.environ|env|config|settings|options|opts|this|self|req|request|ctx|context|secrets|vault|args|params|props)\b|^[A-Za-z_$][\w$]*\(|^(?:string|number|boolean|null|undefined|true|false|none|nil|any|unknown|str|int|bytes|optional)\b|^\[?REDACTED/i;

const RULES: readonly RedactionRule[] = [
  {
    kind: "private_key",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replace: () => "[REDACTED_PRIVATE_KEY]",
  },
  {
    kind: "connection_string_password",
    pattern: /\b((?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?|mssql|sqlserver):\/\/[^\s:/@]+:)([^\s@/]+)@/gi,
    replace: (_match, [prefix = "", password = ""]) => (isPlaceholder(password) ? null : `${prefix}[REDACTED]@`),
  },
  {
    kind: "bearer_token",
    pattern: /\b(authorization["']?\s*[:=]\s*["']?(?:bearer|basic|token)\s+)([A-Za-z0-9._~+/=-]{8,})/gi,
    replace: (_match, [prefix = "", value = ""]) => (isPlaceholder(value) ? null : `${prefix}[REDACTED_TOKEN]`),
  },
  {
    kind: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    replace: () => "[REDACTED_JWT]",
  },
  {
    kind: "api_key",
    pattern:
      /\b(?:sk-(?:ant-|proj-|live-)?[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35}|(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}|xox[abposr]-[A-Za-z0-9-]{10,}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}|glpat-[A-Za-z0-9_-]{20,}|ukm_[A-Za-z0-9_-]{20,})/g,
    replace: () => "[REDACTED_API_KEY]",
  },
  {
    kind: "aws_access_key",
    pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
    replace: () => "[REDACTED_AWS_KEY]",
  },
  {
    kind: "secret_assignment",
    pattern:
      /([A-Za-z0-9_.-]*?(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|access[_-]?token|refresh[_-]?token|bearer[_-]?token|token)["']?\s*[:=]\s*["']?)([^\s"'`,;)]{4,})/gi,
    replace: (_match, [prefix = "", value = ""]) =>
      isPlaceholder(value) || CODE_REFERENCE.test(value) || /^\d+$/.test(value) ? null : `${prefix}[REDACTED]`,
  },
  {
    kind: "credit_card",
    pattern: /\b(?:4\d{3}|5[1-5]\d{2}|2[2-7]\d{2}|3[47]\d{2}|6(?:011|5\d{2}))[ -]?\d{4}[ -]?\d{4}[ -]?\d{1,7}\b/g,
    replace: (match) => (luhnValid(match.replace(/\D/g, "")) ? "[REDACTED_CARD]" : null),
  },
  {
    kind: "national_id",
    pattern: /\b(?:\d{3}-\d{2}-\d{4}|\d{4} \d{4} \d{4})\b/g,
    replace: () => "[REDACTED_ID]",
  },
  {
    kind: "email",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}\b/g,
    replace: (match) => (isNonPersonalEmail(match) ? null : "[REDACTED_EMAIL]"),
  },
];

/**
 * Removes credentials and common personal data before anything is persisted.
 * Heuristic by nature: it favors redacting a harmless value over storing a real secret.
 */
export function redactSensitive(text: string, options: RedactionOptions): RedactionResult {
  const report: Record<string, number> = {};
  let output = text;
  for (const rule of RULES) {
    if (rule.kind === "email" && !options.redactEmails) continue;
    output = output.replace(rule.pattern, (...args: unknown[]) => {
      const match = String(args[0]);
      // Callback args: match, ...captures, offset, input (rules use no named groups).
      const groups = args.slice(1, -2).map((group) => (typeof group === "string" ? group : ""));
      const replacement = rule.replace(match, groups);
      if (replacement === null || replacement === match) return match;
      report[rule.kind] = (report[rule.kind] ?? 0) + 1;
      return replacement;
    });
  }
  return { text: output, report };
}

export function mergeReports(target: Record<string, number>, source: Record<string, number>): void {
  for (const [kind, count] of Object.entries(source)) target[kind] = (target[kind] ?? 0) + count;
}

function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_SECRET.test(value.trim());
}

function isNonPersonalEmail(email: string): boolean {
  const [local = "", domain = ""] = email.toLowerCase().split("@");
  if (["git", "noreply", "no-reply", "donotreply"].includes(local)) return true;
  return /(^|\.)(example\.(com|org|net)|example|test|invalid|localhost)$/.test(domain) || domain.endsWith("noreply.github.com");
}

function luhnValid(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits.charAt(index));
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

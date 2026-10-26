export type ErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "CONFLICT"
  | "UNAUTHENTICATED"
  | "DATABASE_UNAVAILABLE"
  | "SCHEMA_NOT_READY"
  | "RATE_LIMITED"
  | "PAYLOAD_TOO_LARGE"
  | "TIMEOUT"
  | "INTERNAL";

/** Expected, user-facing failure. Messages must never contain secrets or document content. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }
}

export function isAppError(error: unknown, code?: ErrorCode): error is AppError {
  return error instanceof AppError && (code === undefined || error.code === code);
}

/** Thrown by configuration loading; each problem is an actionable sentence. */
export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid configuration:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function withTimeout<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AppError("TIMEOUT", `${label} timed out after ${timeoutMs} ms.`)), timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

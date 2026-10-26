export const LOG_LEVELS = ["debug", "info", "warn", "error", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

type Fields = Record<string, unknown>;
export type LogSink = (line: string) => void;

export interface Logger {
  debug(message: string, fields?: Fields): void;
  info(message: string, fields?: Fields): void;
  warn(message: string, fields?: Fields): void;
  error(message: string, fields?: Fields): void;
  child(bindings: Fields): Logger;
}

const SEVERITY: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const SENSITIVE_KEY =
  /^(authorization|cookie|password|secret|token|api_?key|database_?url|credentials?)$|(password|secret)$|(access|auth|bearer|refresh|api|user)_?token$/i;

const stderrSink: LogSink = (line) => {
  process.stderr.write(`${line}\n`);
};

/**
 * Structured JSON logger. It always writes to stderr so it can never corrupt the
 * stdio MCP channel, and it redacts values of credential-like keys.
 */
export function createLogger(level: LogLevel, bindings: Fields = {}, sink: LogSink = stderrSink): Logger {
  const threshold = SEVERITY[level];
  const write = (entryLevel: Exclude<LogLevel, "silent">, message: string, fields?: Fields): void => {
    if (SEVERITY[entryLevel] < threshold) return;
    const entry = {
      time: new Date().toISOString(),
      level: entryLevel,
      msg: message,
      ...sanitizeFields(bindings),
      ...sanitizeFields(fields ?? {}),
    };
    sink(JSON.stringify(entry));
  };

  return {
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
    child: (extra) => createLogger(level, { ...bindings, ...extra }, sink),
  };
}

function sanitizeFields(fields: Fields): Fields {
  const output: Fields = {};
  for (const [key, value] of Object.entries(fields)) {
    output[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : serialize(value);
  }
  return output;
}

function serialize(value: unknown): unknown {
  if (value instanceof Error) {
    const code = (value as { code?: unknown }).code;
    return { name: value.name, message: value.message, ...(typeof code === "string" ? { code } : {}) };
  }
  return value;
}

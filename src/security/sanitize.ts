import { normalizeNewlines } from "../utils/text.js";

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
/** Zero-width, bidi-override and Unicode "tag" characters can hide instructions from human reviewers. */
const INVISIBLE_CHARS = /[\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]|[\u{E0000}-\u{E007F}]/gu;

const DANGEROUS_BLOCK = /<(script|style|iframe|object|embed|form|template|svg|math)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const DANGEROUS_TAG = /<\/?(?:script|style|iframe|object|embed|form|template|svg|math|meta|link|base|frame|frameset)\b[^>]*>/gi;
const EVENT_HANDLER_ATTR = /(<[a-z][^>]*?)\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const DANGEROUS_MD_URL = /\]\(\s*(?:javascript|vbscript|data):[^)]*\)/gi;
const DANGEROUS_ATTR_URL = /\b(href|src|action|formaction)\s*=\s*(["']?)\s*(?:javascript|vbscript|data):[^"'>\s]*\2/gi;

const WRAPPER_TAGS = /<(\/?)\s*(knowledge_document|knowledge_search_results|untrusted_reference_material)/gi;

const INJECTION_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  [
    "override_instructions",
    /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|system|developer)\b[^.\n]{0,40}\b(instructions?|prompts?|rules|guidelines|messages?)\b/i,
  ],
  ["role_hijack", /\byou are (now|no longer)\b|\bact as (the )?(system|developer|administrator|root)\b|\bnew (system )?instructions?\s*:/i],
  ["prompt_markup", /<\/?\s*(system|assistant|developer|instructions?)\s*>|\[\/?(INST|SYS)\]|<\|im_(start|end)\|>/i],
  [
    "exfiltration",
    /\b(send|post|upload|exfiltrate|leak|forward)\b[^.\n]{0,60}\b(secrets?|credentials?|tokens?|api keys?|passwords?|environment variables|\.env)\b[^.\n]{0,40}\b(to|at)\b/i,
  ],
  ["concealment", /\b(do not|don't|never)\b[^.\n]{0,30}\b(tell|inform|mention|reveal|show)\b[^.\n]{0,20}\b(the )?user\b/i],
];

/** Normalizes newlines and strips control and invisible characters. */
export function sanitizeText(input: string): string {
  return normalizeNewlines(input).replace(CONTROL_CHARS, "").replace(INVISIBLE_CHARS, "");
}

/**
 * Neutralizes active HTML (scripts, frames, event handlers, javascript: URLs) in Markdown prose.
 * Fenced and inline code is preserved verbatim because renderers display it as text.
 */
export function sanitizeMarkdown(input: string): string {
  return mapOutsideCode(sanitizeText(input), (segment) => {
    let output = segment
      .replace(DANGEROUS_BLOCK, "")
      .replace(DANGEROUS_TAG, "")
      .replace(DANGEROUS_MD_URL, "](#)")
      .replace(DANGEROUS_ATTR_URL, '$1="#"');
    for (let pass = 0; pass < 5 && EVENT_HANDLER_ATTR.test(output); pass += 1) {
      output = output.replace(EVENT_HANDLER_ATTR, "$1");
    }
    EVENT_HANDLER_ATTR.lastIndex = 0;
    return output;
  });
}

/** Returns risk flags for text that looks like instructions aimed at an AI model. */
export function detectPromptInjection(text: string): string[] {
  return INJECTION_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([name]) => `prompt_injection:${name}`);
}

/** Prevents stored content from closing the wrapper tags that mark it as untrusted. */
export function neutralizeWrapperTags(text: string): string {
  return text.replace(WRAPPER_TAGS, "&lt;$1$2");
}

function mapOutsideCode(text: string, transform: (segment: string) => string): string {
  const output: string[] = [];
  let prose: string[] = [];
  let fence: string | null = null;

  const flushProse = (): void => {
    if (prose.length === 0) return;
    const segment = prose.join("\n");
    // Odd indexes are inline code spans and stay untouched.
    output.push(
      segment
        .split(/(`+[^`\n]*`+)/)
        .map((part, index) => (index % 2 === 1 ? part : transform(part)))
        .join(""),
    );
    prose = [];
  };

  for (const line of text.split("\n")) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence === null) {
      if (marker) {
        flushProse();
        fence = marker;
        output.push(line);
      } else {
        prose.push(line);
      }
      continue;
    }
    output.push(line);
    const closes =
      marker !== undefined &&
      marker.charAt(0) === fence.charAt(0) &&
      marker.length >= fence.length &&
      line.trim() === marker;
    if (closes) fence = null;
  }
  flushProse();
  return output.join("\n");
}

import { describe, expect, it } from "vitest";
import { redactSensitive } from "../../src/security/redaction.js";

const redact = (text: string, redactEmails = true) => redactSensitive(text, { redactEmails });

describe("redactSensitive", () => {
  it("redacts provider API keys and tokens", () => {
    const input = [
      "openai sk-proj-abcdefghijklmnopqrstuvwx1234",
      `github ghp_${"a".repeat(36)}`,
      "slack xoxb-1234567890-abcdefghij",
      "aws AKIAABCDEFGHIJKLMNOP",
      `ukm ukm_${"b".repeat(43)}`,
    ].join("\n");
    const { text, report } = redact(input);
    expect(text).not.toMatch(/sk-proj-abcdef|ghp_a|xoxb-|AKIAABCDEFGHIJKLMNOP|ukm_bbbb/);
    expect(report.api_key).toBe(4);
    expect(report.aws_access_key).toBe(1);
  });

  it("redacts private keys, JWTs, bearer headers and connection-string passwords", () => {
    const input = [
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----",
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      "curl -H 'Authorization: Bearer abcdef1234567890abcdef'",
      "DATABASE_URL=postgres://app:Sup3rS3cret@db.internal:5432/app",
    ].join("\n");
    const { text, report } = redact(input);
    expect(text).toContain("[REDACTED_PRIVATE_KEY]");
    expect(text).not.toContain("MIIEow");
    expect(text).toContain("[REDACTED_JWT]");
    expect(text).toContain("Authorization: Bearer [REDACTED_TOKEN]");
    expect(text).toContain("postgres://app:[REDACTED]@db.internal:5432/app");
    expect(report).toEqual({ private_key: 1, jwt: 1, bearer_token: 1, connection_string_password: 1 });
  });

  it("redacts secret assignments but keeps placeholders and code references", () => {
    const input = [
      "DB_PASSWORD=hunter2hunter",
      'api_key: "live-9f8e7d6c5b4a"',
      "password: string;",
      "apiKey = process.env.API_KEY",
      "const token = getToken();",
      "maxTokens: 4096",
      "SECRET=${MY_SECRET}",
      "postgres://user:password@localhost:5432/db",
    ].join("\n");
    const { text } = redact(input);
    expect(text).toContain("DB_PASSWORD=[REDACTED]");
    expect(text).toContain('api_key: "[REDACTED]"');
    expect(text).toContain("password: string;");
    expect(text).toContain("apiKey = process.env.API_KEY");
    expect(text).toContain("const token = getToken();");
    expect(text).toContain("maxTokens: 4096");
    expect(text).toContain("SECRET=${MY_SECRET}");
    expect(text).toContain("postgres://user:password@localhost:5432/db");
  });

  it("redacts personal data but keeps example and git addresses", () => {
    const { text, report } = redact(
      "Contact jane.doe@acme-corp.com or git@github.com, see user@example.com. Card 4111 1111 1111 1111. SSN 123-45-6789. Aadhaar 1234 5678 9012.",
    );
    expect(text).toContain("[REDACTED_EMAIL]");
    expect(text).not.toContain("jane.doe");
    expect(text).toContain("git@github.com");
    expect(text).toContain("user@example.com");
    expect(text).toContain("[REDACTED_CARD]");
    expect(report.national_id).toBe(2);
  });

  it("can keep emails when configured and leaves ordinary technical text untouched", () => {
    expect(redact("mail me at jane@acme.io", false).text).toContain("jane@acme.io");
    const input = "Run `npm install pg@8.13.0`, then SELECT version(); timestamps like 1700000000000 are fine.";
    expect(redact(input).text).toBe(input);
  });
});

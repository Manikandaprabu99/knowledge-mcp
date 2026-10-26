import { describe, expect, it } from "vitest";
import { computeFingerprint, duplicateScore } from "../../src/services/deduplication.js";
import { buildOrTsQuery, extractSearchTokens } from "../../src/services/search-query.js";

describe("search query tokens", () => {
  it("extracts lowercase, deduplicated technical tokens", () => {
    expect(extractSearchTokens("How do I fix Node.js ECONNREFUSED in C# / ASP.NET? node.js")).toEqual([
      "how",
      "do",
      "fix",
      "node.js",
      "econnrefused",
      "in",
      "c#",
      "asp.net",
    ]);
  });

  it("never emits to_tsquery operator characters", () => {
    const tokens = extractSearchTokens("alpha & beta | !gamma (delta) 'epsilon' zeta:* <-> eta\\theta");
    expect(tokens).toEqual(["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"]);
    expect(buildOrTsQuery(tokens)).toBe("alpha | beta | gamma | delta | epsilon | zeta | eta | theta");
    expect(buildOrTsQuery([])).toBeNull();
  });
});

describe("duplicate detection", () => {
  it("fingerprints ignore case, whitespace and punctuation", () => {
    expect(computeFingerprint("Query is SLOW!", "Add an index.")).toBe(computeFingerprint("query   is slow", "add an index"));
    expect(computeFingerprint("Query is slow", "Add an index")).not.toBe(computeFingerprint("Query is slow", "Drop the index"));
  });

  it("scores exact and near duplicates", () => {
    expect(duplicateScore({ exact: true, titleSimilarity: 0, problemSimilarity: 0 })).toBe(1);
    expect(duplicateScore({ exact: false, titleSimilarity: 0.8, problemSimilarity: 0.6 })).toBe(0.7);
  });
});

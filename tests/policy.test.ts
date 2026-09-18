import { describe, expect, it } from "vitest";
import { evaluatePolicy } from "../src/security/policy.js";

describe("permission policy", () => {
  it("allows low-risk tools with no missing permission", () => {
    const result = evaluatePolicy({ risk: "LOW", permissions: [] }, new Set(), false);
    expect(result.allowed).toBe(true);
  });

  it("requires explicit approval for high-risk actions", () => {
    const result = evaluatePolicy(
      { risk: "HIGH", permissions: ["calendar.write"] },
      new Set(["calendar.write"]),
      false
    );
    expect(result.allowed).toBe(false);
    expect(result.requiresApproval).toBe(true);
  });

  it("denies missing permissions", () => {
    const result = evaluatePolicy(
      { risk: "CRITICAL", permissions: ["financial.transfer"] },
      new Set(),
      true
    );
    expect(result.allowed).toBe(false);
  });
});

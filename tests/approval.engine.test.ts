import { describe, expect, it } from "vitest";
import { ApprovalEngine } from "../src/approval/engine.js";
import { InMemoryApprovalStore } from "../src/approval/store.js";

describe("ApprovalEngine", () => {
  it("requires the exact tool and arguments and is single-use", async () => {
    const engine = new ApprovalEngine(new InMemoryApprovalStore(), 60_000);
    const input = { amount: 100, destination: "account-1" };
    const request = await engine.request("user-1", "financial.transfer", input, "CRITICAL");

    expect(await engine.consume(request.id, "user-1", "financial.transfer", input)).toBe(false);

    expect(await engine.approve(request.id, "user-1")).toBeDefined();
    expect(await engine.consume(request.id, "user-1", "financial.transfer", { ...input, amount: 101 })).toBe(false);
    expect(await engine.consume(request.id, "user-1", "other.tool", input)).toBe(false);

    expect(await engine.consume(request.id, "user-1", "financial.transfer", input)).toBe(true);
    expect(await engine.consume(request.id, "user-1", "financial.transfer", input)).toBe(false);
  });

  it("isolates approvals between users and rejects expired requests", async () => {
    const engine = new ApprovalEngine(new InMemoryApprovalStore(), 1);
    const request = await engine.request("user-a", "physical.control", { device: "lock-1" }, "HIGH");

    await new Promise(resolve => setTimeout(resolve, 5));

    expect(await engine.approve(request.id, "user-b")).toBeUndefined();
    expect(await engine.approve(request.id, "user-a")).toBeUndefined();
  });
});

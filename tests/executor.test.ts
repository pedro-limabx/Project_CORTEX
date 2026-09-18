import { describe, expect, it } from "vitest";
import { ToolExecutor } from "../src/tools/executor.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { timeTool, calculatorTool } from "../src/tools/builtin.js";

describe("tool executor", () => {
  function setup() {
    const registry = new ToolRegistry();
    registry.register(timeTool);
    registry.register(calculatorTool);
    return new ToolExecutor(registry);
  }

  it("validates tool input with the declared schema", async () => {
    const executor = setup();
    const result = await executor.execute("calculator.evaluate", { expression: 123 }, {
      userId: "test", requestId: "req", dryRun: false, grantedPermissions: new Set()
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Invalid input");
  });

  it("does not execute a tool in dry-run mode", async () => {
    const executor = setup();
    const result = await executor.execute("calculator.evaluate", { expression: "2+2" }, {
      userId: "test", requestId: "req", dryRun: true, grantedPermissions: new Set()
    });
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ dryRun: true });
  });
});

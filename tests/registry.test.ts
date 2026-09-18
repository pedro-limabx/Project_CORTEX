import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../src/tools/registry.js";
import { timeTool } from "../src/tools/builtin.js";

describe("tool registry", () => {
  it("registers and lists tools", () => {
    const registry = new ToolRegistry();
    registry.register(timeTool);
    expect(registry.get("system.time")?.version).toBe("1.0.0");
    expect(registry.list()).toHaveLength(1);
  });
});

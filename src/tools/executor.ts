import { z } from "zod";
import type { ExecutionResult, ToolContext } from "../domain/types.js";
import { evaluatePolicy } from "../security/policy.js";
import { ToolRegistry } from "./registry.js";

export class ToolExecutor {
  constructor(private readonly registry: ToolRegistry) {}

  async execute(
    name: string,
    input: unknown,
    ctx: ToolContext,
    approved = false
  ): Promise<ExecutionResult> {
    const tool = this.registry.get(name);
    if (!tool) return { tool: name, ok: false, error: "Tool not found" };

    const decision = evaluatePolicy(tool, ctx.grantedPermissions, approved);
    if (!decision.allowed) {
      return {
        tool: name,
        ok: false,
        requiresApproval: decision.requiresApproval,
        error: decision.reason
      };
    }

    if (ctx.dryRun) return { tool: name, ok: true, output: { dryRun: true } };

    try {
      const parsed = z.any().parse(input);
      const output = await Promise.race([
        tool.execute(parsed, ctx),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Tool timeout")), 15_000))
      ]);
      return { tool: name, ok: true, output };
    } catch (error) {
      return { tool: name, ok: false, error: error instanceof Error ? error.message : "Unknown tool error" };
    }
  }
}

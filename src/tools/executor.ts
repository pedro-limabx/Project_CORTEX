import { z } from "zod";
import type { ExecutionResult, ToolContext } from "../domain/types.js";
import { evaluatePolicy } from "../security/policy.js";
import { ToolRegistry } from "./registry.js";

const TOOL_TIMEOUT_MS = 15_000;

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
      const schema = tool.inputSchema as { parse?: (value: unknown) => unknown };
      if (!schema || typeof schema.parse !== "function") {
        throw new Error("Tool input schema is not executable");
      }

      const parsed = schema.parse(input);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const output = await Promise.race([
          tool.execute(parsed, ctx),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Tool timeout")), TOOL_TIMEOUT_MS);
          })
        ]);
        return { tool: name, ok: true, output };
      } finally {
        if (timer) clearTimeout(timer);
      }
    } catch (error) {
      if (error instanceof z.ZodError) {
        return {
          tool: name,
          ok: false,
          error: `Invalid input: ${error.issues.map(i => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`
        };
      }
      return {
        tool: name,
        ok: false,
        error: error instanceof Error ? error.message : "Unknown tool error"
      };
    }
  }
}

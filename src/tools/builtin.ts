import { z } from "zod";
import type { ToolDefinition } from "../domain/types.js";

export const calculatorTool: ToolDefinition<{ expression: string }, { result: number }> = {
  name: "calculator.evaluate",
  version: "1.0.0",
  description: "Evaluate a basic arithmetic expression without executing arbitrary code.",
  risk: "LOW",
  permissions: [],
  inputSchema: z.object({ expression: z.string().min(1).max(200) }),
  async execute(input) {
    const expression = input.expression.trim();
    if (!/^[0-9+\-*/().%\s]+$/.test(expression)) {
      throw new Error("Expression contains unsupported characters");
    }
    // Deliberately restricted evaluator for v0.1. Never pass arbitrary user text to eval.
    const result = Function(`"use strict"; return (${expression})`)();
    if (typeof result !== "number" || !Number.isFinite(result)) throw new Error("Invalid calculation result");
    return { result };
  }
};

export const timeTool: ToolDefinition<Record<string, never>, { iso: string }> = {
  name: "system.time",
  version: "1.0.0",
  description: "Return the current server time as an ISO timestamp.",
  risk: "LOW",
  permissions: [],
  inputSchema: z.object({}),
  async execute() {
    return { iso: new Date().toISOString() };
  }
};

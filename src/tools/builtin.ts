import { z } from "zod";
import type { ToolDefinition } from "../domain/types.js";

export const calculatorTool: ToolDefinition<{ expression: string }, { result: number }> = {
  name: "calculator.evaluate",
  version: "1.1.0",
  description: "Evaluate a basic arithmetic expression.",
  risk: "LOW",
  permissions: [],
  inputSchema: z.object({ expression: z.string().min(1).max(200) }),
  async execute(input) {
    const tokens = input.expression.match(/\d+(?:\.\d+)?|[()+\-*/%]/g);
    if (!tokens || tokens.join("") !== input.expression.replace(/\s+/g, "")) {
      throw new Error("Expression contains unsupported characters");
    }

    const values: number[] = [];
    const operators: string[] = [];
    const precedence: Record<string, number> = { "+": 1, "-": 1, "*": 2, "/": 2, "%": 2 };

    const apply = () => {
      const op = operators.pop();
      if (!op) throw new Error("Invalid expression");
      const b = values.pop();
      const a = values.pop();
      if (a === undefined || b === undefined) throw new Error("Invalid expression");
      let value: number;
      if (op === "+") value = a + b;
      else if (op === "-") value = a - b;
      else if (op === "*") value = a * b;
      else if (op === "/") {
        if (b === 0) throw new Error("Division by zero");
        value = a / b;
      } else value = a % b;
      if (!Number.isFinite(value)) throw new Error("Invalid calculation result");
      values.push(value);
    };

    let expectValue = true;
    for (const token of tokens) {
      if (/^\d/.test(token)) {
        if (!expectValue) throw new Error("Invalid expression");
        values.push(Number(token));
        expectValue = false;
      } else if (token === "(") {
        if (!expectValue) throw new Error("Invalid expression");
        operators.push(token);
      } else if (token === ")") {
        if (expectValue) throw new Error("Invalid expression");
        while (operators.length && operators.at(-1) !== "(") apply();
        if (operators.pop() !== "(") throw new Error("Invalid expression");
      } else {
        if (expectValue) {
          if (token !== "-") throw new Error("Invalid expression");
          values.push(0);
        }
        while (
          operators.length &&
          operators.at(-1) !== "(" &&
          precedence[operators.at(-1)] >= precedence[token]
        ) apply();
        operators.push(token);
        expectValue = true;
      }
    }

    if (expectValue) throw new Error("Invalid expression");
    while (operators.length) {
      if (operators.at(-1) === "(") throw new Error("Invalid expression");
      apply();
    }
    if (values.length !== 1) throw new Error("Invalid expression");
    return { result: values[0] };
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

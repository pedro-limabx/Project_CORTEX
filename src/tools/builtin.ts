import { z } from "zod";
import type { ToolDefinition } from "../domain/types.js";

export const calculatorTool: ToolDefinition<{ expression: string }, { result: number }> = {
  name: "calculator.evaluate",
  version: "1.1.1",
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
      } else if (op === "%") {
        if (b === 0) throw new Error("Division by zero");
        value = a % b;
      } else {
        throw new Error("Invalid operator");
      }

      if (!Number.isFinite(value)) throw new Error("Invalid calculation result");
      values.push(value);
    };

    let expectValue = true;

    for (const token of tokens) {
      if (/^\d/.test(token)) {
        if (!expectValue) throw new Error("Invalid expression");
        values.push(Number(token));
        expectValue = false;
        continue;
      }

      if (token === "(") {
        if (!expectValue) throw new Error("Invalid expression");
        operators.push(token);
        continue;
      }

      if (token === ")") {
        if (expectValue) throw new Error("Invalid expression");
        while (operators.length > 0 && operators[operators.length - 1] !== "(") {
          apply();
        }
        if (operators.pop() !== "(") throw new Error("Invalid expression");
        expectValue = false;
        continue;
      }

      if (expectValue) {
        if (token !== "-") throw new Error("Invalid expression");
        values.push(0);
      }

      const topOperator = operators[operators.length - 1];
      const topPrecedence = topOperator === undefined ? -1 : precedence[topOperator];
      const tokenPrecedence = precedence[token];

      if (tokenPrecedence === undefined) throw new Error("Invalid operator");

      while (
        operators.length > 0 &&
        topOperator !== "(" &&
        topPrecedence >= tokenPrecedence
      ) {
        apply();
      }

      operators.push(token);
      expectValue = true;
    }

    if (expectValue) throw new Error("Invalid expression");

    while (operators.length > 0) {
      if (operators[operators.length - 1] === "(") throw new Error("Invalid expression");
      apply();
    }

    const result = values[0];
    if (result === undefined || values.length !== 1) throw new Error("Invalid expression");

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

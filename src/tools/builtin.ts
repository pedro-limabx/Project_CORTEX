import { z } from "zod";
import type { ToolDefinition } from "../domain/types.js";

export const calculatorTool: ToolDefinition<{ expression: string }, { result: number }> = {
  name: "calculator.evaluate",
  version: "1.2.0",
  description: "Evaluate arithmetic expressions. Supports +, -, *, /, %, ^, parentheses, and sqrt(...). Use this tool for numerical calculations; do not use it for general factual questions.",
  risk: "LOW",
  permissions: [],
  inputSchema: z.object({ expression: z.string().min(1).max(200) }),
  async execute(input) {
    const expression = input.expression.replace(/\s+/g, "");
    const tokens = expression.match(/sqrt|\d+(?:\.\d+)?|[()+\-*/%^]/g);

    if (!tokens || tokens.join("") !== expression) {
      throw new Error("Expression contains unsupported characters");
    }

    let index = 0;

    const peek = () => tokens[index];
    const consume = () => tokens[index++];

    const parsePrimary = (): number => {
      const token = consume();
      if (!token) throw new Error("Invalid expression");

      if (token === "+") return parsePrimary();
      if (token === "-") return -parsePrimary();

      if (token === "sqrt") {
        if (consume() !== "(") throw new Error("sqrt requires parentheses");
        const value = parseAdditive();
        if (consume() !== ")") throw new Error("Invalid expression");
        if (value < 0) throw new Error("Square root of a negative number");
        const result = Math.sqrt(value);
        if (!Number.isFinite(result)) throw new Error("Invalid calculation result");
        return result;
      }

      if (token === "(") {
        const value = parseAdditive();
        if (consume() !== ")") throw new Error("Invalid expression");
        return value;
      }

      if (!/^\d/.test(token)) throw new Error("Invalid expression");
      const value = Number(token);
      if (!Number.isFinite(value)) throw new Error("Invalid calculation result");
      return value;
    };

    const parsePower = (): number => {
      const left = parsePrimary();
      if (peek() === "^") {
        consume();
        const right = parsePower();
        const result = left ** right;
        if (!Number.isFinite(result)) throw new Error("Invalid calculation result");
        return result;
      }
      return left;
    };

    const parseMultiplicative = (): number => {
      let value = parsePower();

      while (peek() === "*" || peek() === "/" || peek() === "%") {
        const operator = consume();
        const right = parsePower();

        if ((operator === "/" || operator === "%") && right === 0) {
          throw new Error("Division by zero");
        }

        if (operator === "*") value *= right;
        else if (operator === "/") value /= right;
        else value %= right;

        if (!Number.isFinite(value)) throw new Error("Invalid calculation result");
      }

      return value;
    };

    const parseAdditive = (): number => {
      let value = parseMultiplicative();

      while (peek() === "+" || peek() === "-") {
        const operator = consume();
        const right = parseMultiplicative();
        value = operator === "+" ? value + right : value - right;

        if (!Number.isFinite(value)) throw new Error("Invalid calculation result");
      }

      return value;
    };

    const result = parseAdditive();

    if (index !== tokens.length) throw new Error("Invalid expression");
    return { result };
  }
};

export const timeTool: ToolDefinition<Record<string, never>, { iso: string }> = {
  name: "system.time",
  version: "1.0.0",
  description: "Return the current server time as an ISO timestamp. Use this tool only when the user explicitly asks for the current time/date or when current server time is directly relevant.",
  risk: "LOW",
  permissions: [],
  inputSchema: z.object({}),
  async execute() {
    return { iso: new Date().toISOString() };
  }
};

import {
  WorkflowInputError,
  type WorkflowRun
} from "./types.js";

/**
 * Input bindings are deliberately narrow:
 * - Object value: { "$fromStep": "step-id", "path": "result" }
 * - String interpolation: "{{steps.step-id.result}}/3"
 *
 * Only direct dependencies can be referenced. A template never reads other
 * workflows, environment variables or arbitrary object properties.
 */
const REFS = /\{\{steps\.([a-zA-Z][a-zA-Z0-9_-]{0,63})\.([a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+){0,7})\}\}/g;
const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);
const MAX_DEPTH = 12;
const MAX_JSON_BYTES = 16_384;
const MAX_RESOLVED_BYTES = 65_536;

type Binding = { $fromStep: string; path: string };

function referencePaths(path: string): string[] {
  const parts = path.split(".");
  if (!parts.length || parts.length > 8 ||
    parts.some(part => !/^[a-zA-Z0-9_-]+$/.test(part) || FORBIDDEN.has(part))) {
    throw new WorkflowInputError("Invalid binding path: " + path);
  }
  return parts;
}

function checkReference(stepId: string, source: string, path: string, dependsOn: string[]) {
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(source)) {
    throw new WorkflowInputError("Invalid referenced step: " + source);
  }
  if (!dependsOn.includes(source)) {
    throw new WorkflowInputError(
      "Step " + stepId + " must declare " + source + " in dependsOn to reference its output"
    );
  }
  referencePaths(path);
}

function isReference(value: unknown): value is Binding {
  return value !== null && typeof value === "object"
    && !Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, "$fromStep");
}

function walk(
  value: unknown,
  stepId: string,
  dependsOn: string[],
  resolve: ((source: string, path: string) => unknown) | undefined,
  depth: number
): unknown {
  if (depth > MAX_DEPTH) throw new WorkflowInputError("Workflow input nesting is too deep");

  if (typeof value === "string") {
    const fragments = [...value.matchAll(REFS)];
    if (!fragments.length) {
      if (value.includes("{{steps.")) {
        throw new WorkflowInputError("Malformed step interpolation in " + stepId);
      }
      return value;
    }
    for (const match of fragments) {
      checkReference(stepId, match[1]!, match[2]!, dependsOn);
    }
    if (value.replace(REFS, "").includes("{{steps.")) {
      throw new WorkflowInputError("Malformed step interpolation in " + stepId);
    }
    if (!resolve) return value;
    return value.replace(REFS, (_whole, source: string, path: string) => {
      const result = resolve(source, path);
      if (typeof result !== "string" && typeof result !== "number" && typeof result !== "boolean") {
        throw new WorkflowInputError("Cannot interpolate a non-scalar output from " + source);
      }
      if (typeof result === "number" && !Number.isFinite(result)) {
        throw new WorkflowInputError("Referenced number is not finite");
      }
      return String(result);
    });
  }

  if (isReference(value)) {
    const obj = value as unknown as Record<string, unknown>;
    if (Object.keys(obj).length !== 2 || !Object.prototype.hasOwnProperty.call(obj, "path")
      || typeof obj.$fromStep !== "string" || typeof obj.path !== "string") {
      throw new WorkflowInputError("Invalid $fromStep binding object");
    }
    checkReference(stepId, obj.$fromStep, obj.path, dependsOn);
    return resolve ? resolve(obj.$fromStep, obj.path) : { $fromStep: obj.$fromStep, path: obj.path };
  }
  if (Array.isArray(value)) {
    if (value.length > 1000) throw new WorkflowInputError("Workflow array input too long");
    return value.map(part => walk(part, stepId, dependsOn, resolve, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, part] of Object.entries(obj)) {
      if (FORBIDDEN.has(key)) throw new WorkflowInputError("Unsafe workflow input property");
      output[key] = walk(part, stepId, dependsOn, resolve, depth + 1);
    }
    return output;
  }
  if (value === null || typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))) return value;
  throw new WorkflowInputError("Workflow inputs must be JSON values");
}

function jsonSafe(value: unknown, maxBytes: number): unknown {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new WorkflowInputError("Workflow input is not JSON serializable");
  }
  if (json === undefined || Buffer.byteLength(json, "utf8") > maxBytes) {
    throw new WorkflowInputError("Workflow input exceeds the allowed JSON size");
  }
  return JSON.parse(json) as unknown;
}

export function inspectStepInput(
  value: unknown,
  stepId: string,
  dependsOn: string[]
): { input: unknown; hasBindings: boolean } {
  const safe = jsonSafe(value, MAX_JSON_BYTES);
  const validated = walk(safe, stepId, dependsOn, undefined, 0);
  const hasBindings = containsBindings(validated, 0);
  return { input: jsonSafe(validated, MAX_JSON_BYTES), hasBindings };
}

/**
 * Recovery handlers cannot access the (nonexistent) output of their failed
 * source. Reject that wiring while building the workflow rather than after
 * operator authorization.
 */
export function referencesStepOutput(value: unknown, source: string): boolean {
  if (typeof value === "string") {
    return [...value.matchAll(REFS)].some(match => match[1] === source);
  }
  if (isReference(value)) return value.$fromStep === source;
  if (Array.isArray(value)) return value.some(item => referencesStepOutput(item, source));
  if (value && typeof value === "object") {
    return Object.values(value).some(item => referencesStepOutput(item, source));
  }
  return false;
}

function containsBindings(value: unknown, depth: number): boolean {
  if (depth > MAX_DEPTH) return false;
  if (typeof value === "string") return value.includes("{{steps.");
  if (isReference(value)) return true;
  if (Array.isArray(value)) return value.some(item => containsBindings(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.values(value).some(item => containsBindings(item, depth + 1));
  }
  return false;
}

export function readStepOutput(
  run: WorkflowRun,
  source: string,
  path: string,
  allowNull = false
): unknown {
  const previous = run.steps.find(step => step.id === source);
  if (!previous || previous.status !== "COMPLETED" || previous.output === undefined) {
    throw new WorkflowInputError("Referenced output is unavailable: " + source);
  }
  let value: unknown = previous.output;
  for (const segment of referencePaths(path)) {
    if (value === null || typeof value !== "object" ||
        !Object.prototype.hasOwnProperty.call(value, segment)) {
      throw new WorkflowInputError("Referenced output path is missing: " + source + "." + path);
    }
    value = (value as Record<string, unknown>)[segment];
  }
  if (value === undefined || (value === null && !allowNull)) {
    throw new WorkflowInputError("Referenced output path is empty: " + source + "." + path);
  }
  return value;
}

export function resolveStepInput(
  run: WorkflowRun,
  stepId: string
): unknown {
  const step = run.steps.find(item => item.id === stepId);
  if (!step) throw new WorkflowInputError("Workflow step not found");
  const safe = jsonSafe(step.input, MAX_JSON_BYTES);
  const resolved = walk(
    safe, step.id, step.dependsOn,
    (source, path) => readStepOutput(run, source, path),
    0
  );
  return jsonSafe(resolved, MAX_RESOLVED_BYTES);
}

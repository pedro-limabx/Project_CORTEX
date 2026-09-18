export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type Permission =
  | "calendar.read"
  | "calendar.write"
  | "message.send"
  | "file.read"
  | "file.write"
  | "financial.transfer"
  | "physical.control"
  | "admin";

export interface ToolDefinition<I = unknown, O = unknown> {
  name: string;
  version: string;
  description: string;
  risk: RiskLevel;
  permissions: Permission[];
  inputSchema: unknown;
  execute(input: I, ctx: ToolContext): Promise<O>;
}

export interface ToolContext {
  userId: string;
  requestId: string;
  dryRun: boolean;
  grantedPermissions: Set<Permission>;
}

export interface MemoryRecord {
  id: string;
  userId: string;
  kind: "SESSION" | "PREFERENCE" | "FACT" | "TASK" | "ACTION";
  content: string;
  importance: number;
  createdAt: string;
  updatedAt: string;
}

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface LLMResponse {
  text: string;
  provider: string;
  model?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface LLMProvider {
  chat(messages: LLMMessage[], options?: { temperature?: number }): Promise<LLMResponse>;
}

export interface ExecutionResult {
  tool: string;
  ok: boolean;
  requiresApproval?: boolean;
  output?: unknown;
  error?: string;
}

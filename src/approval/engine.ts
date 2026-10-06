import crypto from "node:crypto";
import type { RiskLevel } from "../domain/types.js";
import type { ApprovalRequest, ApprovalStore } from "./store.js";

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export class ApprovalEngine {
  constructor(private readonly store: ApprovalStore, private readonly ttlMs = DEFAULT_TTL_MS) {}

  async request(userId: string, tool: string, input: unknown, risk: RiskLevel): Promise<ApprovalRequest> {
    const now = Date.now();
    const request: ApprovalRequest = {
      id: crypto.randomUUID(),
      userId,
      tool,
      argumentsHash: this.hash(input),
      risk,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlMs).toISOString()
    };
    await this.store.create(request);
    return request;
  }

  async approve(id: string, userId: string): Promise<ApprovalRequest | undefined> {
    return this.store.approve(id, userId);
  }

  async reject(id: string, userId: string): Promise<ApprovalRequest | undefined> {
    return this.store.reject(id, userId);
  }

  async consume(id: string, userId: string, tool: string, input: unknown): Promise<boolean> {
    const request = await this.store.get(id);
    if (!request || request.userId !== userId || request.tool !== tool || request.argumentsHash !== this.hash(input)) return false;
    return Boolean(await this.store.consume(id, userId));
  }

  private hash(input: unknown): string {
    return crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
  }
}

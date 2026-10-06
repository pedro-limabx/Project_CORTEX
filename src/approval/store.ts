import type { RiskLevel } from "../domain/types.js";

export interface ApprovalRequest {
  id: string;
  userId: string;
  tool: string;
  argumentsHash: string;
  risk: RiskLevel;
  createdAt: string;
  expiresAt: string;
  approvedAt?: string;
  consumedAt?: string;
  rejectedAt?: string;
}

export interface ApprovalStore {
  create(request: ApprovalRequest): Promise<void>;
  get(id: string): Promise<ApprovalRequest | undefined>;
  approve(id: string, userId: string): Promise<ApprovalRequest | undefined>;
  reject(id: string, userId: string): Promise<ApprovalRequest | undefined>;
  consume(id: string, userId: string): Promise<ApprovalRequest | undefined>;
}

export class InMemoryApprovalStore implements ApprovalStore {
  private readonly requests = new Map<string, ApprovalRequest>();

  async create(request: ApprovalRequest): Promise<void> {
    this.requests.set(request.id, { ...request });
  }

  async get(id: string): Promise<ApprovalRequest | undefined> {
    const request = this.requests.get(id);
    return request ? { ...request } : undefined;
  }

  async approve(id: string, userId: string): Promise<ApprovalRequest | undefined> {
    const request = this.requests.get(id);
    if (!request || request.userId !== userId || request.approvedAt || request.rejectedAt || request.consumedAt) return undefined;
    if (Date.parse(request.expiresAt) <= Date.now()) return undefined;
    request.approvedAt = new Date().toISOString();
    return { ...request };
  }

  async reject(id: string, userId: string): Promise<ApprovalRequest | undefined> {
    const request = this.requests.get(id);
    if (!request || request.userId !== userId || request.approvedAt || request.rejectedAt || request.consumedAt) return undefined;
    request.rejectedAt = new Date().toISOString();
    return { ...request };
  }

  async consume(id: string, userId: string): Promise<ApprovalRequest | undefined> {
    const request = this.requests.get(id);
    if (!request || request.userId !== userId || !request.approvedAt || request.rejectedAt || request.consumedAt) return undefined;
    if (Date.parse(request.expiresAt) <= Date.now()) return undefined;
    request.consumedAt = new Date().toISOString();
    return { ...request };
  }
}

import type { AuditRecord } from "../domain/types.js";

export interface AuditStore {
  record(entry: AuditRecord): Promise<void>;
}

export class InMemoryAuditStore implements AuditStore {
  private readonly entries: AuditRecord[] = [];

  async record(entry: AuditRecord): Promise<void> {
    this.entries.push(entry);
  }
}

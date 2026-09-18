import type { MemoryRecord } from "../domain/types.js";

export interface MemoryStore {
  save(record: MemoryRecord): Promise<void>;
  search(userId: string, query: string, limit: number): Promise<MemoryRecord[]>;
}

export class InMemoryStore implements MemoryStore {
  private readonly records: MemoryRecord[] = [];

  async save(record: MemoryRecord): Promise<void> {
    this.records.push(record);
  }

  async search(userId: string, query: string, limit: number): Promise<MemoryRecord[]> {
    const q = query.toLowerCase();
    return this.records
      .filter(r => r.userId === userId && r.content.toLowerCase().includes(q))
      .sort((a, b) => b.importance - a.importance)
      .slice(0, limit);
  }
}

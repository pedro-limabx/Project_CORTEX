import type { Permission } from "../domain/types.js";
import type { PermissionGrant, PermissionStore } from "./store.js";

export class InMemoryPermissionStore implements PermissionStore {
  private readonly grants = new Map<string, PermissionGrant>();

  async listForUser(userId: string): Promise<PermissionGrant[]> {
    return [...this.grants.values()]
      .filter(grant => grant.userId === userId)
      .sort((a, b) => a.permission.localeCompare(b.permission));
  }

  async has(userId: string, permission: Permission): Promise<boolean> {
    return this.grants.has(this.key(userId, permission));
  }

  async grant(userId: string, permission: Permission, grantedBy: string): Promise<void> {
    this.grants.set(this.key(userId, permission), {
      userId,
      permission,
      grantedAt: new Date().toISOString(),
      grantedBy
    });
  }

  async revoke(userId: string, permission: Permission): Promise<void> {
    this.grants.delete(this.key(userId, permission));
  }

  private key(userId: string, permission: Permission): string {
    return `${userId}:${permission}`;
  }
}

import type { Permission } from "../domain/types.js";
import type { PermissionStore } from "./store.js";

export class PermissionEngine {
  constructor(private readonly store: PermissionStore) {}

  async getPermissions(userId: string): Promise<Set<Permission>> {
    const grants = await this.store.listForUser(userId);
    return new Set(grants.map(grant => grant.permission));
  }

  async has(userId: string, permission: Permission): Promise<boolean> {
    return this.store.has(userId, permission);
  }

  async grant(userId: string, permission: Permission, grantedBy: string): Promise<void> {
    await this.store.grant(userId, permission, grantedBy);
  }

  async revoke(userId: string, permission: Permission): Promise<void> {
    await this.store.revoke(userId, permission);
  }
}

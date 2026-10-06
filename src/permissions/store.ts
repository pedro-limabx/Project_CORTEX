import type { Permission } from "../domain/types.js";

export interface PermissionGrant {
  userId: string;
  permission: Permission;
  grantedAt: string;
  grantedBy: string;
}

export interface PermissionStore {
  listForUser(userId: string): Promise<PermissionGrant[]>;
  has(userId: string, permission: Permission): Promise<boolean>;
  grant(userId: string, permission: Permission, grantedBy: string): Promise<void>;
  revoke(userId: string, permission: Permission): Promise<void>;
}

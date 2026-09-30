import { Pool } from "pg";
import type { Permission } from "../domain/types.js";
import type { PermissionGrant, PermissionStore } from "./store.js";

const permissions: Permission[] = [
  "calendar.read", "calendar.write", "message.send", "file.read",
  "file.write", "financial.transfer", "physical.control", "admin"
];

export class PostgresPermissionStore implements PermissionStore {
  constructor(private readonly pool: Pool) {}

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS neuron_permission_grants (
        user_id TEXT NOT NULL,
        permission TEXT NOT NULL,
        granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, permission)
      )
    `);
  }

  async listForUser(userId: string): Promise<PermissionGrant[]> {
    const result = await this.pool.query(
      `SELECT user_id, permission, granted_at
       FROM neuron_permission_grants WHERE user_id = $1 ORDER BY permission`,
      [userId]
    );
    return result.rows.map(row => ({
      userId: String(row.user_id),
      permission: parsePermission(row.permission),
      grantedAt: new Date(row.granted_at).toISOString()
    }));
  }

  async grant(userId: string, permission: Permission): Promise<void> {
    await this.pool.query(
      `INSERT INTO neuron_permission_grants (user_id, permission)
       VALUES ($1, $2) ON CONFLICT (user_id, permission) DO NOTHING`,
      [userId, permission]
    );
  }

  async revoke(userId: string, permission: Permission): Promise<void> {
    await this.pool.query(
      `DELETE FROM neuron_permission_grants WHERE user_id = $1 AND permission = $2`,
      [userId, permission]
    );
  }
}

function parsePermission(value: unknown): Permission {
  if (typeof value === "string" && permissions.includes(value as Permission)) {
    return value as Permission;
  }
  throw new Error("Unknown permission found in database");
}

import type { Pool } from "pg";
import type { Permission } from "../domain/types.js";
import type { PermissionGrant, PermissionStore } from "./store.js";

export class PostgresPermissionStore implements PermissionStore {
  constructor(private readonly pool: Pool) {}

  async listForUser(userId: string): Promise<PermissionGrant[]> {
    const result = await this.pool.query<{
      user_id: string;
      permission: Permission;
      granted_at: Date;
      granted_by: string;
    }>(
      `
      SELECT user_id, permission, granted_at, granted_by
      FROM neuron_permission_grants
      WHERE user_id = $1
      ORDER BY permission
      `,
      [userId]
    );

    return result.rows.map(row => ({
      userId: row.user_id,
      permission: row.permission,
      grantedAt: row.granted_at.toISOString(),
      grantedBy: row.granted_by
    }));
  }

  async has(userId: string, permission: Permission): Promise<boolean> {
    const result = await this.pool.query(
      `
      SELECT 1
      FROM neuron_permission_grants
      WHERE user_id = $1 AND permission = $2
      LIMIT 1
      `,
      [userId, permission]
    );
    return result.rowCount === 1;
  }

  async grant(userId: string, permission: Permission, grantedBy: string): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO neuron_permission_grants (user_id, permission, granted_at, granted_by)
      VALUES ($1, $2, NOW(), $3)
      ON CONFLICT (user_id, permission)
      DO UPDATE SET granted_at = NOW(), granted_by = EXCLUDED.granted_by
      `,
      [userId, permission, grantedBy]
    );
  }

  async revoke(userId: string, permission: Permission): Promise<void> {
    await this.pool.query(
      `
      DELETE FROM neuron_permission_grants
      WHERE user_id = $1 AND permission = $2
      `,
      [userId, permission]
    );
  }
}

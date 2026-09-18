import type { Permission, RiskLevel, ToolDefinition } from "../domain/types.js";

const order: Record<RiskLevel, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3
};

export interface PolicyDecision {
  allowed: boolean;
  requiresApproval: boolean;
  reason: string;
}

export function evaluatePolicy(
  tool: Pick<ToolDefinition, "risk" | "permissions">,
  granted: Set<Permission>,
  approved: boolean
): PolicyDecision {
  for (const permission of tool.permissions) {
    if (!granted.has(permission)) {
      return { allowed: false, requiresApproval: false, reason: `Missing permission: ${permission}` };
    }
  }

  const requiresApproval = order[tool.risk] >= order.HIGH;
  if (requiresApproval && !approved) {
    return { allowed: false, requiresApproval: true, reason: `Explicit approval required for ${tool.risk} action` };
  }

  return { allowed: true, requiresApproval: false, reason: "Policy accepted" };
}

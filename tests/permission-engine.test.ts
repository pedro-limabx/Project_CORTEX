import { describe, expect, it } from "vitest";
import type { Permission } from "../src/domain/types.js";
import { PermissionEngine } from "../src/permissions/engine.js";
import { InMemoryPermissionStore } from "../src/permissions/in-memory-store.js";

describe("PermissionEngine", () => {
  it("loads, grants and revokes permissions", async () => {
    const engine = new PermissionEngine(new InMemoryPermissionStore());

    expect(await engine.has("user-1", "message.send")).toBe(false);
    expect(await engine.getPermissions("user-1")).toEqual(new Set());

    await engine.grant("user-1", "message.send", "system");
    await engine.grant("user-1", "calendar.read", "system");

    expect(await engine.has("user-1", "message.send")).toBe(true);
    expect(await engine.getPermissions("user-1")).toEqual(
      new Set<Permission>(["calendar.read", "message.send"])
    );

    await engine.revoke("user-1", "message.send");

    expect(await engine.has("user-1", "message.send")).toBe(false);
    expect(await engine.getPermissions("user-1")).toEqual(
      new Set<Permission>(["calendar.read"])
    );
  });

  it("keeps permissions isolated between users", async () => {
    const engine = new PermissionEngine(new InMemoryPermissionStore());

    await engine.grant("user-a", "file.read", "system");

    expect(await engine.has("user-a", "file.read")).toBe(true);
    expect(await engine.has("user-b", "file.read")).toBe(false);
    expect(await engine.getPermissions("user-b")).toEqual(new Set());
  });
});

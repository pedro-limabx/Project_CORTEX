[object Object]

describe("calculator capabilities", () => {
  it("supports square roots, powers, and parentheses", async () => {
    const executor = setup();

    const sqrt = await executor.execute("calculator.evaluate", { expression: "sqrt(92)" }, {
      userId: "test", requestId: "req", dryRun: false, grantedPermissions: new Set()
    });
    expect(sqrt).toMatchObject({ ok: true, output: { result: expect.closeTo(9.591663046625438, 10) } });

    const power = await executor.execute("calculator.evaluate", { expression: "2^8" }, {
      userId: "test", requestId: "req", dryRun: false, grantedPermissions: new Set()
    });
    expect(power).toMatchObject({ ok: true, output: { result: 256 } });
  });

  it("rejects square roots of negative numbers", async () => {
    const executor = setup();
    const result = await executor.execute("calculator.evaluate", { expression: "sqrt(-1)" }, {
      userId: "test", requestId: "req", dryRun: false, grantedPermissions: new Set()
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Square root of a negative number");
  });
});

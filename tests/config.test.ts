import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";

describe("configuration", () => {
  it("parses LOCAL_TEST_MODE=false as false", () => {
    expect(parseConfig({ LOCAL_TEST_MODE: "false" }).LOCAL_TEST_MODE).toBe(false);
  });

  it("parses LOCAL_TEST_MODE=true as true", () => {
    expect(parseConfig({ LOCAL_TEST_MODE: "true" }).LOCAL_TEST_MODE).toBe(true);
  });

  it("rejects invalid boolean values", () => {
    expect(() => parseConfig({ LOCAL_TEST_MODE: "not-a-boolean" })).toThrow();
  });
});

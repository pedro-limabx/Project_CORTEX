import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";

describe("configuration", () => {
  it("parses LOCAL_TEST_MODE=false as false", () => {
    expect(parseConfig({ LOCAL_TEST_MODE: "false" }).LOCAL_TEST_MODE).toBe(false);
  });

  it("parses LOCAL_TEST_MODE=true as true", () => {
    expect(parseConfig({ LOCAL_TEST_MODE: "true" }).LOCAL_TEST_MODE).toBe(true);
  });

  it("keeps Google Calendar optional when .env example values are empty", () => {
    const config=parseConfig({
      GOOGLE_CALENDAR_CLIENT_ID:"",
      GOOGLE_CALENDAR_CLIENT_SECRET:"",
      GOOGLE_CALENDAR_REDIRECT_URI:"",
      GOOGLE_CALENDAR_ENCRYPTION_KEY:""
    });
    expect(config.GOOGLE_CALENDAR_CLIENT_ID).toBeUndefined();
    expect(config.GOOGLE_CALENDAR_REDIRECT_URI).toBeUndefined();
    expect(config.GOOGLE_CALENDAR_ENCRYPTION_KEY).toBeUndefined();
    expect(()=>parseConfig({GOOGLE_CALENDAR_ENCRYPTION_KEY:"1234"})).toThrow();
  });
  it("rejects invalid boolean values", () => {
    expect(() => parseConfig({ LOCAL_TEST_MODE: "not-a-boolean" })).toThrow();
  });
});

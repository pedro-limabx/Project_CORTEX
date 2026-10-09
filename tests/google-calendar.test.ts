import {describe,expect,it} from "vitest";
import {
  GOOGLE_CALENDAR_SCOPE,pkceChallenge,validateGoogleCalendarSettings
} from "../src/integrations/google-calendar.js";

const base={
  clientId:"google-client-id.apps.googleusercontent.com",
  clientSecret:"google-test-secret",
  redirectUri:"https://codespace-3000.app.github.dev/api/integrations/google-calendar/callback",
  encryptionKey:"a".repeat(64)
};
describe("V18 read-only Google Calendar OAuth input",()=>{
  it("accepts HTTPS callback and optional localhost HTTP for local development",()=>{
    expect(validateGoogleCalendarSettings(base).redirectUri).toBe(base.redirectUri);
    expect(validateGoogleCalendarSettings({...base,
      redirectUri:"http://localhost:3000/api/integrations/google-calendar/callback"
    }).redirectUri).toContain("localhost");
  });
  it("rejects external HTTP, tampered callback paths, invalid key or URL credentials",()=>{
    for(const bad of [
      {redirectUri:"http://example.com/api/integrations/google-calendar/callback"},
      {redirectUri:"https://codespace-3000.app.github.dev/other"},
      {redirectUri:"https://user:pass@codespace-3000.app.github.dev/api/integrations/google-calendar/callback"},
      {redirectUri:"https://codespace-3000.app.github.dev/api/integrations/google-calendar/callback?evil=1"},
      {encryptionKey:"abc"}, {clientId:""}, {clientSecret:""}
    ])expect(()=>validateGoogleCalendarSettings({...base,...bad})).toThrow();
  });
  it("supports S256 PKCE and requests no write privileges",()=>{
    expect(pkceChallenge("sufficiently random code verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(GOOGLE_CALENDAR_SCOPE).toBe("https://www.googleapis.com/auth/calendar.events.readonly");
    expect(GOOGLE_CALENDAR_SCOPE).not.toBe("https://www.googleapis.com/auth/calendar");
  });
});

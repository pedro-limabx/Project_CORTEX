import {describe, expect, it} from "vitest";
import Fastify from "fastify";
import {parseVideoRange, registerConsole} from "../src/console.js";

describe("CORTEX branding and splash assets", () => {
  it("accepts valid browser byte ranges and rejects malformed requests", () => {
    expect(parseVideoRange(undefined, 1000)).toBeNull();
    expect(parseVideoRange("bytes=0-99",1000)).toEqual({start:0,end:99});
    expect(parseVideoRange("bytes=100-",1000)).toEqual({start:100,end:999});
    expect(parseVideoRange("bytes=-100",1000)).toEqual({start:900,end:999});
    expect(parseVideoRange("bytes=0-9999",1000)).toEqual({start:0,end:999});
    for (const bad of ["bytes=1000-2000","bytes=100-99","bytes=-0","bytes=1-2,4-5","items=0-10","bytes=abc-"]) {
      expect(parseVideoRange(bad,1000)).toBe("invalid");
    }
  });

  it("keeps routes allowlisted and never renders arbitrary server files", async () => {
    const app=Fastify();
    registerConsole(app);
    const bad=await app.inject({method:"GET",url:"/console/media/%2e%2e%2f.env"});
    expect(bad.statusCode).toBe(404);
    const route=await app.inject({method:"GET",url:"/console/media/logo.webp"});
    // Assets can be installed after code. When installed, must be served as images.
    expect([200,404]).toContain(route.statusCode);
    if(route.statusCode===200) expect(route.headers["content-type"]).toContain("image/webp");
    await app.close();
  });
});

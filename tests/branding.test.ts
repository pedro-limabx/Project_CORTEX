import {describe, expect, it, vi} from "vitest";
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {runInNewContext} from "node:vm";
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


  it("never traps the dashboard on autoplay failures, video end or a skip click", async () => {
    const source = await readFile(resolve(process.cwd(),"web/app.js"),"utf8");
    const start = source.indexOf("function startCortexSplash() {");
    const end = source.indexOf("\nstartCortexSplash();",start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const callbacks = new Map<string,() => void>();
    const timers: Array<() => void> = [];
    const video = {
      hidden:false,muted:false,pause:vi.fn(),play:vi.fn(() => Promise.reject(new Error("autoplay blocked"))),
      addEventListener:(type:string,cb:() => void) => callbacks.set("video:"+type,cb)
    };
    const skip = {addEventListener:(type:string,cb:() => void) => callbacks.set("skip:"+type,cb)};
    const splash = {hidden:true};
    const fallback = {hidden:true};
    const classes = {add:vi.fn(),remove:vi.fn()};
    const document = {
      querySelector:(selector:string) => ({
        "#cortex-splash":splash,"#cortex-splash-video":video,
        "#cortex-splash-fallback":fallback,"#cortex-splash-skip":skip
      })[selector as "#cortex-splash"],
      querySelectorAll:() => []
    };
    const window = {matchMedia:()=>({matches:false}),
      setTimeout:(fn:() => void) => {timers.push(fn);return timers.length;},
      clearTimeout:vi.fn()};
    const boot = runInNewContext(source.slice(start,end)+"\nstartCortexSplash;",{
      document,window,Error
    }) as () => void;
    Object.assign(document,{body:{classList:classes}});
    // The source accesses document.body only when the splash actually runs.
    boot();
    expect(splash.hidden).toBe(false);
    await vi.waitFor(()=>expect(fallback.hidden).toBe(false));
    expect(video.hidden).toBe(true);
    expect(timers.length).toBeGreaterThanOrEqual(2);
    timers[timers.length-1]?.();
    expect(splash.hidden).toBe(true);
    expect(video.pause).toHaveBeenCalledOnce();
    expect(classes.remove).toHaveBeenCalledWith("cortex-opening");
    callbacks.get("skip:click")?.();
    expect(video.pause).toHaveBeenCalledOnce(); // idempotent
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

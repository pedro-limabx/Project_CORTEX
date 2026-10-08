import {describe,expect,it} from "vitest";
import {diagnoseMonitorHealth} from "../src/autonomy/diagnostics.js";
import type {Settings} from "../src/autonomy/store.js";
const now=new Date("2026-10-08T14:00:00.000Z");
const settings:Settings={enabled:true,intervalSeconds:60,cooldownSeconds:600,
  lastCheckedAt:"2026-10-08T13:59:00.000Z",lastCheckOk:true,nextCheckAt:"2026-10-08T14:00:05.000Z"};
describe("V11 health diagnostics",()=>{
  it("distinguishes disabled, starting, healthy and degraded",()=>{
    expect(diagnoseMonitorHealth(settings,now).status).toBe("healthy");
    expect(diagnoseMonitorHealth({...settings,enabled:false,lastCheckOk:false},now).status).toBe("disabled");
    expect(diagnoseMonitorHealth({...settings,lastCheckedAt:null,lastCheckOk:null},now).status).toBe("starting");
    expect(diagnoseMonitorHealth({...settings,lastCheckOk:false},now).status).toBe("degraded");
  });
  it("flags an overdue scan and never exposes workflow content",()=>{
    const result=diagnoseMonitorHealth({...settings,nextCheckAt:"2026-10-08T13:58:00.000Z"},now);
    expect(result).toMatchObject({status:"overdue",overdueSeconds:120,readOnlyChecks:true});
    expect(result).not.toHaveProperty("objective");
  });
});

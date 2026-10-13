import {describe,expect,it,vi} from "vitest";
import {
  computePriorities,validatePriorityRequest,type PriorityDependencies
} from "../src/priorities/service.js";

const now=new Date("2026-10-13T12:00:00.000Z");
const reminder=(id:string)=>({
  id,title:"Revisar o trabalho "+id,status:"DUE" as const,
  dueAt:"2026-10-13T08:00:00.000Z",
  createdAt:"2026-10-12T20:00:00.000Z",
  triggeredAt:"2026-10-13T08:01:00.000Z",
  completedAt:null,cancelledAt:null
});
const proposal=(id:string,minutes:number,status:"PENDING_REVIEW"|"APPROVED"="PENDING_REVIEW")=>({
  id,title:"Reagendar reunião "+id,status,source:"cortex" as const,
  createdAt:"2026-10-13T10:00:00.000Z",
  reviewedAt:status==="APPROVED"?"2026-10-13T10:05:00.000Z":null,
  expiresAt:new Date(now.getTime()+minutes*60_000).toISOString(),
  expired:false,appliedAt:null
});
function deps(overrides?:{
  reminders?:ReturnType<typeof reminder>[];proposals?:ReturnType<typeof proposal>[];
  alerts?:Array<{workflowId:string;severity:"critical"|"attention";status:string;updatedAt:string}>
}){
  const alerts=(overrides?.alerts??[]).map(x=>({...x,
    version:1,acknowledged:false,objective:"Teste",message:"",nextAction:""
  }));
  const list=vi.fn(async(_user:string,_view:string,_limit:number)=>
    overrides?.reminders??[]);
  const plans=vi.fn(async(_user:string,_limit:number)=>overrides?.proposals??[]);
  const inbox=vi.fn(async(_user:string,_options:{view:string;limit:number})=>({
    alerts,scope:{sampled:alerts.length,limit:100,isAllTime:false},
    readOnly:true
  }));
  return {backend:{reminders:{list},proposals:{list:plans},alerts:{inbox}
    } as unknown as PriorityDependencies,list,plans,inbox};
}
describe("V26 explainable supervised priorities",()=>{
  it("accepts only fixed filters and integer 1..100 limits",()=>{
    for(const filter of ["all","urgent","reminders","workflows","decisions"]){
      expect(validatePriorityRequest(filter,30)).toEqual({filter,limit:30});
    }
    for(const invalid of ["",null,"everything","';DROP TABLE",undefined])
      expect(validatePriorityRequest(invalid,30)).toBeNull();
    for(const invalid of [0,-2,101,1.5,"30",NaN,Infinity,null])
      expect(validatePriorityRequest("all",invalid)).toBeNull();
  });
  it("orders critical alerts above overdue reminders and expiring proposals",async()=>{
    const d=deps({reminders:[reminder("rem-1")],
      proposals:[proposal("review-1",4),proposal("review-2",10),proposal("approved",20,"APPROVED")],
      alerts:[
        {workflowId:"wf-critical",severity:"critical",status:"FAILED",
          updatedAt:"2026-10-13T11:00:00.000Z"},
        {workflowId:"wf-attention",severity:"attention",status:"AWAITING_APPROVAL",
          updatedAt:"2026-10-13T11:05:00.000Z"}
      ]});
    const snapshot=await computePriorities(d.backend,"owner","all",30,now);
    expect(snapshot.items.map(x=>x.severity)).toEqual([
      "critical","high","high","high","medium","medium"
    ]);
    expect(snapshot.items[0]?.kind).toBe("workflow");
    expect(snapshot.items.every(x=>x.readOnly===true)).toBe(true);
    expect(snapshot.actionExecuted).toBe(false);
    expect(snapshot.counts).toEqual({critical:1,high:3,medium:2,inSample:6});
    expect(d.list).toHaveBeenCalledWith("owner","due",101);
    expect(d.plans).toHaveBeenCalledWith("owner",101);
    expect(d.inbox).toHaveBeenCalledWith("owner",{view:"unread",limit:100});
  });
  it("urgent and source-specific filters avoid unnecessary backend reads",async()=>{
    const d=deps({reminders:[reminder("rem")],
      proposals:[proposal("review-1",20)],
      alerts:[{workflowId:"wf",severity:"critical",status:"FAILED",
        updatedAt:"2026-10-13T11:00:00.000Z"}]});
    const urgent=await computePriorities(d.backend,"owner","urgent",30,now);
    expect(urgent.items).toHaveLength(2);
    expect(urgent.items.every(x=>x.severity!=="medium")).toBe(true);
    d.list.mockClear();d.plans.mockClear();d.inbox.mockClear();
    const alone=await computePriorities(d.backend,"owner","reminders",30,now);
    expect(alone.items).toHaveLength(1);
    expect(d.list).toHaveBeenCalledOnce();
    expect(d.plans).not.toHaveBeenCalled();
    expect(d.inbox).not.toHaveBeenCalled();
  });
  it("ignores expired proposals and decisions already rejected/applied",async()=>{
    const expired=proposal("expired",-1);
    const rejected={...proposal("rejected",10),status:"REJECTED"};
    const applied={...proposal("applied",10),status:"APPLIED"};
    const d=deps({proposals:[expired,rejected,applied] as ReturnType<typeof proposal>[]});
    const snapshot=await computePriorities(d.backend,"owner","decisions",30,now);
    expect(snapshot.items).toEqual([]);
    expect(snapshot.counts.inSample).toBe(0);
  });
  it("marks capped and paged samples as partial; never claims a global total",async()=>{
    const d=deps({reminders:Array.from({length:101},(_,i)=>reminder("r"+i))});
    const snapshot=await computePriorities(d.backend,"owner","reminders",10,now);
    expect(snapshot.items).toHaveLength(10);
    expect(snapshot.counts.inSample).toBe(100);
    expect(snapshot.partial).toBe(true);
    expect(snapshot.warnings.join(" ")).toContain("100 lembretes");
    expect(snapshot.scope).toBe("sampled_current_state");
  });
});

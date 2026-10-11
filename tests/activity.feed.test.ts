import {describe,expect,it,vi} from "vitest";
import type {Pool} from "pg";
import {PostgresActivityFeed,validActivityRequest,activityCategories} from "../src/activity/feed.js";

describe("V25 private, read-only activity feed",()=>{
  it("accepts only documented filters and a bounded integer limit",()=>{
    expect(activityCategories).toEqual([
      "all","reminders","agenda","notifications","tools"
    ]);
    expect(validActivityRequest("all",30)).toEqual({category:"all",limit:30});
    expect(validActivityRequest("tools",100)).toEqual({category:"tools",limit:100});
    for(const category of ["unknown","google","';DROP TABLE users;--",null,undefined]){
      expect(validActivityRequest(category,20)).toBeNull();
    }
    for(const limit of [0,-1,101,10.5,"30",NaN,Infinity,null,undefined]){
      expect(validActivityRequest("all",limit)).toBeNull();
    }
  });
  it("passes owner/category/limit strictly as parameters and projects only safe fields",async()=>{
    const query=vi.fn(async()=>({rows:[{
      category:"tools",status:"FAILED",
      description:"Ferramenta executada: calculator.evaluate",
      reference_id:"private-id",event_key:"private-id:executed",
      occurred_at:"2026-10-11T12:00:00.000Z"
    }]}));
    const repository=new PostgresActivityFeed({query} as unknown as Pick<Pool,"query">);
    const result=await repository.list("owner-with-'quotation","tools",5);
    expect(query).toHaveBeenCalledOnce();
    const [sql,params]=query.mock.calls[0] as unknown as [string,unknown[]];
    expect(params).toEqual(["owner-with-'quotation","tools",5]);
    expect(sql).toContain("WHERE user_id=$1");
    expect(sql).toContain("LIMIT ($3::integer + 1)");
    expect(sql).not.toContain("owner-with-'quotation");
    expect(result).toMatchObject({category:"tools",truncated:false,readOnly:true,
      source:"cortex-postgresql",entries:[{
        category:"tools",status:"FAILED",source:"cortex",
        referenceId:"private-id",id:"private-id:executed"
      }]});
    expect(JSON.stringify(result)).not.toContain("approvalToken");
  });
  it("reports partial responses and does not make unsafe followup calls",async()=>{
    const rows=Array.from({length:3},(_,i)=>({
      category:"reminders",status:"CREATED",description:"Lembrete "+i,
      reference_id:"reference-"+i,event_key:"reference-"+i+":created",
      occurred_at:new Date(Date.now()-i*1000).toISOString()
    }));
    const query=vi.fn(async()=>({rows}));
    const feed=new PostgresActivityFeed({query} as unknown as Pick<Pool,"query">);
    const data=await feed.list("owner","all",2);
    expect(data.entries).toHaveLength(2);
    expect(data.truncated).toBe(true);
    expect(query).toHaveBeenCalledOnce();
    expect(data.disclaimer).toContain("Não inclui eventos externos");
  });
});

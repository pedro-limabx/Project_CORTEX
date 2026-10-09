import {test} from "node:test";
import assert from "node:assert/strict";
import {classifyMediaResponse} from "./doctor-branding.mjs";
test("distinguishes route missing from media file missing",()=>{
  assert.equal(classifyMediaResponse(404,'{"message":"Route GET:/console/media/logo.webp not found"}'),"route_not_registered");
  assert.equal(classifyMediaResponse(404,'{"message":"Startup video asset not installed"}'),"file_not_found_by_server");
  assert.equal(classifyMediaResponse(404,'{"message":"Brand logo asset not installed"}'),"file_not_found_by_server");
});
test("handles working HTTP resources and unavailable servers",()=>{
  assert.equal(classifyMediaResponse(200),"available");
  assert.equal(classifyMediaResponse(206),"available");
  assert.equal(classifyMediaResponse(0),"unreachable");
  assert.equal(classifyMediaResponse(401),"unexpected_status");
  assert.equal(classifyMediaResponse(404,"another error"),"unknown_404");
});

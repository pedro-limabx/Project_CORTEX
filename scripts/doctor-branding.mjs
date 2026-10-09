import "dotenv/config";
import { stat, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const expected = [
  { name: "LOGO", file: "web/assets/cortex-logo.webp", path: "/console/media/logo.webp" },
  { name: "VÍDEO", file: "web/assets/cortex-intro.mp4", path: "/console/media/intro.mp4" }
];

export function classifyMediaResponse(status, body = "") {
  if (status === 200 || status === 206) return "available";
  if (status === 404 && /Route (GET|HEAD):\/console\/media\//i.test(body)) return "route_not_registered";
  if (status === 404 && /(asset not installed|arquivo não encontrado)/i.test(body)) return "file_not_found_by_server";
  if (status === 404) return "unknown_404";
  if (status === 0) return "unreachable";
  return "unexpected_status";
}

function output(label, value) {
  console.log(label.padEnd(24) + String(value));
}
function command(commandName, args) {
  try { return execFileSync(commandName, args, {cwd: root, encoding:"utf8", timeout:3000}).trim(); }
  catch { return "(não disponível)"; }
}
async function fetchProbe(base, endpoint, useRange = false) {
  try {
    const response = await fetch(base + endpoint, {
      headers: useRange ? {"Range":"bytes=0-15"} : {},
      signal: AbortSignal.timeout(5000), cache:"no-store"
    });
    let body = "";
    if (!response.ok) body = (await response.text()).slice(0,300);
    else await response.body?.cancel();
    return {status:response.status, contentType:response.headers.get("content-type"), body};
  } catch (error) {
    return {status:0,contentType:null,body:error instanceof Error ? error.message : "Sem conexão"};
  }
}
async function inspectFile(file) {
  try {
    const bytes = (await stat(resolve(root,file))).size;
    return bytes > 0 ? `${(bytes / 1024).toFixed(1)} KiB` : "VAZIO";
  } catch { return "AUSENTE"; }
}
export async function run() {
  const port = process.env.CORTEX_DIAG_PORT || process.env.PORT || "3000";
  const base = process.env.CORTEX_DIAG_URL || `http://127.0.0.1:${port}`;
  console.log("=== CORTEX — Diagnóstico da logo e abertura ===");
  output("Pasta do projeto:", root);
  output("Pasta do terminal:", process.cwd());
  output("Commit local:", command("git",["rev-parse","--short","HEAD"]));
  const registered = (await readFile(resolve(root,"src/console.ts"),"utf8")).includes('app.get("/console/media/logo.webp"');
  output("Rotas no código-fonte:", registered ? "PRESENTES" : "AUSENTES — atualize a main");
  const localFiles = [];
  for (const resource of expected) {
    const size = await inspectFile(resource.file);
    localFiles.push(size);
    output(resource.name + " no disco:", size);
  }
  output("URL investigada:", base);
  const health = await fetchProbe(base,"/health");
  output("Resposta /health:", `HTTP ${health.status}`);
  if (health.status === 0) {
    console.log("\nDIAGNÓSTICO: Não há resposta nessa porta. Confira PORT no .env, reinicie o servidor e tente novamente.");
    return 1;
  }
  let features;
  if (health.status === 200) {
    try {
      const response = await fetch(base + "/health",{signal:AbortSignal.timeout(5000)});
      const json = await response.json();
      features = json.capabilities?.brandingMediaRoutes;
    } catch { /* old process may return a different response */ }
  }
  output("Rotas desta versão:", features === true ? "CONFIRMADAS" : "NÃO CONFIRMADAS — backend antigo?");
  const outcomes = [];
  for (const resource of expected) {
    const response = await fetchProbe(base,resource.path,resource.name === "VÍDEO");
    const kind = classifyMediaResponse(response.status,response.body);
    outcomes.push(kind);
    output(resource.name + " via HTTP:", `HTTP ${response.status} / ${kind}`);
    if (response.body) output("Motivo:",response.body.replace(/\s+/g," ").slice(0,190));
  }
  console.log("\n=== Próxima ação recomendada ===");
  if (!registered) {
    console.log("As rotas não existem no código local: git switch main && git pull --ff-only origin main");
  } else if (outcomes.includes("route_not_registered") || features !== true) {
    console.log("Os arquivos e as rotas podem estar corretos, mas a porta responde com uma versão antiga.");
    console.log("Confira quem atende na porta: ss -lntp | grep ':" + port + "'");
    console.log("No terminal desse processo, Ctrl+C; aguarde a porta ficar livre e inicie da raiz: npm run dev");
    console.log("Se o processo não for seu, identifique o PID antes de interrompê-lo. Não use pkill genérico.");
  } else if (outcomes.includes("file_not_found_by_server")) {
    console.log("As rotas existem, mas o processo não encontra os arquivos.");
    console.log("Confira o diretório de trabalho da instância Node; reinicie com 'cd " + root + " && npm run dev'.");
    if (localFiles.some(x=>x==="AUSENTE"||x==="VAZIO")) console.log("É necessário instalar os arquivos web/assets/cortex-logo.webp e cortex-intro.mp4.");
  } else if (outcomes.every(x=>x==="available")) {
    console.log("Logo e vídeo estão acessíveis. Recarregue /console com Ctrl+Shift+R.");
    console.log("Se a abertura não tocar, examine a aba Network/Console do navegador e as configurações de redução de movimento.");
  } else {
    console.log("Examine os códigos e motivos de HTTP acima; confira também a URL e o processo da porta " + port + ".");
  }
  console.log("\nDiagnóstico somente leitura: nenhum processo ou arquivo foi modificado.");
  return outcomes.every(x=>x==="available")?0:1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().then(code=>{ process.exitCode=code; }).catch(error=>{
    console.error("Falha no diagnóstico:", error.message);
    process.exitCode=1;
  });
}

"use strict";

// Interface experimental. Nenhum token é persistido, e todo texto remoto usa textContent.
const state = {
  token: "",
  workflows: [],
  tasks: [],
  tools: [],
  workflowId: null,
  taskId: null,
  lastChat: null,
  busy: false
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));
const statusLabels = {
  ACTIVE: "Ativo",
  AWAITING_APPROVAL: "Aguardando aprovação",
  WAITING_APPROVAL: "Aguardando aprovação",
  REPLANNING: "Replanejando",
  NEEDS_RECONCILIATION: "Verificação necessária",
  RECOVERY_REQUIRED: "Recuperação exige confirmação",
  RECOVERING: "Recuperação supervisionada",
  COMPLETED_WITH_FAILURES: "Concluído com recuperação",
  COMPLETED: "Concluído",
  FAILED: "Falhou",
  PENDING: "Pendente",
  SKIPPED: "Ignorada",
  RUNNING: "Executando",
  PLANNED: "Planejado"
};

function node(tag, className = "", text = "") {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text == null ? "" : String(text);
  return element;
}
function clear(element) {
  element.replaceChildren();
  return element;
}
function fmt(value) {
  return JSON.stringify(value, null, 2);
}
function dateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? String(value)
    : date.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}
function statusPill(value) {
  const text = statusLabels[value] || value || "—";
  return node("span", "status " + String(value || "").toLowerCase(), text);
}
function info(text, className = "blank") {
  return node("div", className, text);
}
function prettyBlock(value) {
  return node("pre", "inspect-pre", fmt(value));
}
function headline(text) {
  return node("h3", "inspect-title", text);
}
function makeButton(label, className, onClick) {
  const button = node("button", "btn " + className, label);
  button.type = "button";
  button.addEventListener("click", () => action(() => onClick(), button));
  return button;
}
function textDetail(parent, title, text) {
  parent.append(headline(title), node("p", "inspect-info", text));
}
function showNotice(message, kind = "") {
  const container = $("#notice");
  container.className = "notice" + (kind ? " " + kind : "");
  container.textContent = String(message);
  container.hidden = false;
}
function hideNotice() {
  $("#notice").hidden = true;
}
async function api(path, options = {}) {
  const headers = { Accept: "application/json" };
  if (state.token) headers.Authorization = "Bearer " + state.token;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(path, {
    method: options.method || "GET",
    headers,
    credentials: "same-origin",
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
  });
  const raw = await response.text();
  let data = {};
  if (raw) {
    try { data = JSON.parse(raw); }
    catch { throw new Error("O servidor não retornou JSON válido."); }
  }
  if (!response.ok) {
    if (response.status === 401) throw new Error("A API exige um token válido. Informe o CORTEX_API_TOKEN na Visão geral.");
    throw new Error((data && data.error) || ("Falha HTTP " + response.status));
  }
  return data;
}
async function action(operation, button = null) {
  if (state.busy) return;
  state.busy = true;
  if (button) button.disabled = true;
  hideNotice();
  try {
    await operation();
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "Ocorreu um erro inesperado.", "error");
  } finally {
    state.busy = false;
    if (button) button.disabled = false;
  }
}
function tab(name) {
  const labels = {
    overview: "Visão geral", chat: "NEURON Chat",
    workflows: "Workflows v2", tasks: "Tarefas", tools: "Ferramentas"
  };
  if (!labels[name]) return;
  $$("[data-panel]").forEach(panel => { panel.hidden = panel.dataset.panel !== name; });
  $$(".nav-button").forEach(button => button.classList.toggle("active", button.dataset.tab === name));
  $("#page-name").textContent = labels[name];
  hideNotice();
  if (name === "workflows") action(loadWorkflows);
  if (name === "tasks") action(loadTasks);
  if (name === "tools") action(loadTools);
}
$$("[data-tab]").forEach(button => button.addEventListener("click", () => tab(button.dataset.tab)));

function setConnected(isConnected) {
  const badge = $("#connection");
  badge.className = isConnected ? "connection" : "connection offline";
  badge.textContent = isConnected ? "● API online" : "● API indisponível";
}
async function checkHealth() {
  try {
    const health = await api("/health");
    setConnected(Boolean(health.ok));
    $("#stat-health").textContent = health.ok ? "Online" : "Erro";
    $("#stat-health-hint").textContent = health.version ? "CORTEX " + health.version : "Servidor detectado";
  } catch {
    setConnected(false);
    $("#stat-health").textContent = "Offline";
    $("#stat-health-hint").textContent = "Verifique o servidor";
  }
}
async function loadTools() {
  state.tools = await api("/api/tools");
  $("#stat-tools").textContent = String(state.tools.length);
  renderTools();
}
async function loadWorkflows() {
  const data = await api("/api/workflows?limit=30");
  state.workflows = data.workflows || [];
  $("#stat-workflows").textContent = String(state.workflows.length);
  renderWorkflowList();
  if (state.workflowId) {
    try {
      const selected = await api("/api/workflows/" + encodeURIComponent(state.workflowId));
      renderWorkflowDetail(selected);
    } catch (error) {
      state.workflowId = null;
      $("#workflow-detail").replaceChildren(info("Selecione um workflow para inspecionar."));
      throw error;
    }
  }
}
async function loadTasks() {
  const data = await api("/api/tasks?limit=30");
  state.tasks = data.tasks || [];
  $("#stat-tasks").textContent = String(state.tasks.length);
  renderTaskList();
  if (state.taskId) {
    const selected = await api("/api/tasks/" + encodeURIComponent(state.taskId));
    renderTaskDetail(selected);
  }
}
async function refreshAll() {
  await checkHealth();
  const results = await Promise.allSettled([loadTools(), loadWorkflows(), loadTasks()]);
  const rejected = results.find(result => result.status === "rejected");
  if (rejected) throw rejected.reason;
}
$("#refresh").addEventListener("click", (event) => action(refreshAll, event.currentTarget));
$("#use-token").addEventListener("click", (event) => action(async () => {
  state.token = $("#token").value.trim();
  $("#token").value = "";
  await refreshAll();
  showNotice("Conexão verificada. O token permanece apenas nesta aba.", "success");
}, event.currentTarget));
$("#clear-token").addEventListener("click", (event) => action(async () => {
  state.token = "";
  $("#token").value = "";
  await refreshAll();
  showNotice("Token removido da memória desta aba.", "success");
}, event.currentTarget));

// NEURON Chat
function addMessage(who, value, fromUser = false) {
  const history = $("#chat-history");
  if (history.querySelector(".placeholder")) clear(history);
  const bubble = node("div", "message" + (fromUser ? " me" : ""));
  bubble.append(node("span", "message-label", who), node("div", "", value));
  history.append(bubble);
  history.scrollTop = history.scrollHeight;
}
// Single chat submission path: Enter and the button BOTH call the API directly.
// In particular, do not use requestSubmit(): native form validation can prevent
// the submit handler from running, even after keydown already consumed Enter.
// Chat has its own pending flag; background dashboard refreshes must not drop messages.
let chatSending = false;
async function sendChatMessage() {
  if (chatSending) return;
  const input = $("#message");
  const message = input.value.trim();
  if (!message) return;

  const sendButton = $("#chat-form button[type=submit]");
  const previousLabel = sendButton.textContent;
  chatSending = true;
  sendButton.disabled = true;
  sendButton.textContent = "Enviando...";
  showNotice("Mensagem enviada ao servidor. Aguardando resposta do NEURON...");

  try {
    const dryRun = $("#dry-run").checked;
    const result = await api("/api/chat", { method: "POST", body: { message, dryRun } });
    hideNotice();
    // Only clear the submitted draft, preserving new text typed while waiting.
    if (input.value.trim() === message) input.value = "";
    addMessage("VOCÊ", message, true);
    state.lastChat = result;
    addMessage("NEURON", result.text || "Nenhuma resposta textual recebida.");
    renderChatInspection(result);
    if (result.taskId) {
      try {
        await loadTasks();
      } catch {
        // Refreshing history is secondary; never treat an answered chat as unsent.
      }
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Não foi possível enviar a mensagem.";
    showNotice("Falha ao enviar ao NEURON: " + reason, "error");
    // Keep the message in the textarea so the user can retry.
  } finally {
    chatSending = false;
    sendButton.disabled = false;
    sendButton.textContent = previousLabel;
  }
}

// Enter sends; Shift+Enter creates a newline. Respect text composition.
$("#message").addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229
      || event.ctrlKey || event.altKey || event.metaKey) return;
  event.preventDefault();
  void sendChatMessage();
});

$("#chat-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void sendChatMessage();
});
function renderChatInspection(result) {
  const target = clear($("#chat-inspect"));
  if (result?.workflowReport) {
    const report = result.workflowReport;
    const pill = node("div", "detail-meta");
    pill.append(node("span", "status completed", "Consulta somente leitura"));
    target.append(pill, headline(report.mode === "single"
      ? "Acompanhamento do workflow" : "Resumo dos workflows"));
    if (report.workflows.length === 0) {
      target.append(info("Nenhum workflow encontrado para esta consulta."));
    } else {
      report.workflows.forEach(item => {
        const box = node("div", "workflow-step");
        const top = node("div", "workflow-step-top");
        top.append(node("strong", "", item.objective), statusPill(item.status));
        box.append(top, node("p", "", item.completed + " concluídas · "
          + (item.skipped || 0) + " ignoradas · "
          + (item.failed || 0) + " falhas · " + item.percent + "% resolvido"));
        box.append(node("p", "", item.attention));
        box.append(node("p", "row-meta", "ID: " + item.id));
        target.append(box);
      });
    }
    return;
  }
  if (!result || !result.plan) {
    target.append(info("O agente retornou uma resposta sem plano."));
    return;
  }
  const plan = result.plan;
  const meta = node("div", "detail-meta");
  meta.append(statusPill(plan.status), node("span", "row-meta", String(result.steps || 0) + " rodadas de execução"));
  target.append(meta);
  textDetail(target, "Objetivo", plan.objective || "—");
  if (result.taskId) {
    textDetail(target, "ID da tarefa", result.taskId);
    target.append(makeButton("Abrir tarefa ↗", "btn-outline", async () => {
      state.taskId = result.taskId;
      tab("tasks");
      await loadTasks();
    }));
  }
  target.append(headline("Etapas"), prettyBlock(plan.steps || []));
  target.append(headline("Resultados das ferramentas"), prettyBlock(result.toolResults || []));
}

// Quick status questions are read-only; never override an unfinished chat draft.
function askWorkflowStatus(id) {
  tab("chat");
  if (chatSending) {
    showNotice("Aguarde a resposta atual antes de solicitar outro acompanhamento.");
    return;
  }
  const input = $("#message");
  if (input.value.trim()) {
    showNotice("Há um rascunho no chat. Envie ou apague sua mensagem antes de consultar os workflows.");
    input.focus();
    return;
  }
  input.value = id
    ? "Qual o status do workflow " + id + "?"
    : "Como estão meus workflows?";
  void sendChatMessage();
}

$("#chat-workflow-status").addEventListener("click", () => askWorkflowStatus());

// Workflows
const presets = {
  chain: {
    objective: "Calcular 25*18 e dividir o resultado por 3",
    steps: [
      { id: "primeiro", tool: "calculator.evaluate", input: { expression: "25*18" } },
      {
        id: "segundo", tool: "calculator.evaluate",
        input: { expression: "{{steps.primeiro.result}}/3" },
        dependsOn: ["primeiro"]
      }
    ]
  },
  fork: {
    objective: "Executar etapas independentes antes da conclusão",
    steps: [
      { id: "a", tool: "calculator.evaluate", input: { expression: "7*8" } },
      { id: "b", tool: "calculator.evaluate", input: { expression: "12*12" } },
      { id: "c", tool: "calculator.evaluate", input: { expression: "{{steps.a.result}}+{{steps.b.result}}" }, dependsOn: ["a", "b"] }
    ]
  },
  conditional: {
    objective: "Conceder desconto conforme resultado de uma medição",
    steps: [
      { id: "medicao", tool: "calculator.evaluate", input: { expression: "25*18" } },
      {
        id: "desconto-maior", tool: "calculator.evaluate",
        input: { expression: "{{steps.medicao.result}}*0.90" },
        dependsOn: ["medicao"],
        when: { step: "medicao", path: "result", operator: "gte", value: 400 }
      },
      {
        id: "desconto-menor", tool: "calculator.evaluate",
        input: { expression: "{{steps.medicao.result}}*0.95" },
        dependsOn: ["medicao"],
        when: { step: "medicao", path: "result", operator: "lt", value: 400 }
      },
      {
        id: "conclusao", tool: "calculator.evaluate",
        input: { expression: "{{steps.medicao.result}}/3" },
        dependsOn: ["medicao", "desconto-maior", "desconto-menor"],
        dependsMode: "settled"
      }
    ]
  },
  recovery: {
    objective: "Demonstrar falha comprovada e recuperação supervisionada",
    steps: [
      { id: "original", tool: "calculator.evaluate", input: { expression: "10/0" } },
      {
        id: "bloqueada", tool: "calculator.evaluate",
        input: { expression: "10+20" }, dependsOn: ["original"]
      },
      {
        id: "alternativa", tool: "calculator.evaluate",
        input: { expression: "10+5" },
        dependsOn: ["original"], onFailureOf: "original"
      },
      {
        id: "conclusao", tool: "calculator.evaluate",
        input: { expression: "{{steps.alternativa.result}}*2" },
        dependsOn: ["alternativa"]
      }
    ]
  },
  invalid: {
    objective: "Testar validação de dependências cíclicas",
    steps: [
      { id: "a", tool: "calculator.evaluate", input: { expression: "1+1" }, dependsOn: ["b"] },
      { id: "b", tool: "calculator.evaluate", input: { expression: "2+2" }, dependsOn: ["a"] }
    ]
  }
};
function resetExample() {
  $("#workflow-json").value = fmt(presets[$("#preset").value]);
}
$("#propose-workflow").addEventListener("click", event => action(async () => {
  const objective = $("#workflow-objective").value.trim();
  if (!objective) throw new Error("Descreva primeiro o processo que o NEURON deve planejar.");
  const proposal = await api("/api/workflows/propose", {
    method: "POST",
    body: { objective }
  });
  $("#workflow-json").value = fmt(proposal.definition);
  const feedback = [
    proposal.message,
    "Este é somente um rascunho: nada foi criado ou executado.",
    ...(proposal.warnings || [])
  ].filter(Boolean).join(" ");
  $("#proposal-feedback").textContent = feedback;
  showNotice("Proposta validada e colocada no editor. Revise e clique em Criar workflow somente se concordar.", "success");
}, event.currentTarget));
$("#preset").addEventListener("change", resetExample);
$("#reset-example").addEventListener("click", resetExample);
$("#create-workflow").addEventListener("click", event => action(async () => {
  let definition;
  try { definition = JSON.parse($("#workflow-json").value); }
  catch { throw new Error("O JSON informado não é válido. Corrija a sintaxe."); }
  const workflow = await api("/api/workflows", { method: "POST", body: definition });
  state.workflowId = workflow.id;
  await loadWorkflows();
  showNotice("Workflow criado. Selecione Avançar etapa para executar sua primeira ferramenta.", "success");
}, event.currentTarget));
$("#refresh-workflows").addEventListener("click", event => action(loadWorkflows, event.currentTarget));

function renderWorkflowList() {
  const target = clear($("#workflow-list"));
  if (!state.workflows.length) { target.append(info("Ainda não existem workflows. Crie um usando o editor.")); return; }
  state.workflows.forEach(workflow => {
    const button = node("button", "resource-row" + (workflow.id === state.workflowId ? " selected" : ""));
    button.type = "button";
    const top = node("div", "row-head");
    top.append(node("strong", "", workflow.objective), statusPill(workflow.status));
    button.append(top, node("div", "row-meta",
      dateTime(workflow.updatedAt) + " · " + workflow.progress.completed + " concluídas"
      + (workflow.progress.skipped ? " · " + workflow.progress.skipped + " ignoradas" : "")
      + (workflow.progress.failed ? " · " + workflow.progress.failed + " falhas" : "")
      + " · " + workflow.progress.percent + "% resolvido"));
    button.addEventListener("click", () => action(async () => {
      state.workflowId = workflow.id;
      renderWorkflowList();
      renderWorkflowDetail(await api("/api/workflows/" + encodeURIComponent(workflow.id)));
    }, button));
    target.append(button);
  });
}
function stepView(step) {
  const item = node("div", "workflow-step");
  const top = node("div", "workflow-step-top");
  top.append(node("strong", "", step.id + " · " + step.tool), statusPill(step.status));
  item.append(top);
  if (step.dependsOn && step.dependsOn.length) item.append(node("p", "", "Depende de: " + step.dependsOn.join(", ")));
  if (step.dependsMode === "settled") item.append(node("p", "", "Juntada: aguarda os caminhos terminarem ou serem ignorados."));
  if (step.onFailureOf) {
    item.append(node("p", "", "Recuperação supervisionada para falha da etapa: " + step.onFailureOf));
  }
  if (step.when) {
    const operators = { eq: "=", neq: "≠", gt: ">", gte: "≥", lt: "<", lte: "≤" };
    item.append(node("p", "", "Condição: " + step.when.step + "." + step.when.path
      + " " + (operators[step.when.operator] || step.when.operator)
      + " " + JSON.stringify(step.when.value)));
  }
  if (step.skipReason) item.append(node("p", "", "Não executada: " + step.skipReason));
  if (step.input !== undefined) {
    item.append(node("p", "", "Entrada original:"), prettyBlock(step.input));
  }
  if (step.error) item.append(node("p", "", "Erro: " + step.error));
  if (step.approvalId) item.append(node("p", "", "Aprovação: " + step.approvalId));
  if (step.resolvedInput !== undefined) {
    item.append(node("p", "", "Entrada resolvida utilizada:"), prettyBlock(step.resolvedInput));
  }
  if (step.output !== undefined) {
    item.append(node("p", "", "Resultado produzido:"), prettyBlock(step.output));
  }
  return item;
}
function renderWorkflowDetail(workflow) {
  const target = clear($("#workflow-detail"));
  if (!workflow) return;
  target.append(node("h3", "detail-title", workflow.objective));
  const meta = node("div", "detail-meta");
  meta.append(statusPill(workflow.status), node("span", "row-meta", "Versão " + workflow.version));
  target.append(meta);
  const bar = node("progress", "progressbar");
  bar.max = 100;
  bar.value = workflow.progress.percent;
  bar.setAttribute("aria-label", "Progresso do workflow");
  target.append(bar, node("div", "progress-caption",
    workflow.progress.completed + " concluídas · "
    + (workflow.progress.skipped || 0) + " ignoradas · "
    + (workflow.progress.failed || 0) + " falhas · "
    + workflow.progress.percent + "% resolvido"));
  target.append(node("p", "row-meta", "ID: " + workflow.id));
  if (workflow.recoveries?.length) {
    target.append(headline("Autorizações de recuperação (sem execução)"));
    workflow.recoveries.forEach(record => {
      target.append(node("p", "inspect-info",
        record.stepId + " · " + dateTime(record.authorizedAt) + " · " + record.note));
    });
  }

  const buttons = node("div", "actions");
  if (workflow.status === "ACTIVE" || workflow.status === "RECOVERING") {
    buttons.append(makeButton("▶ Avançar etapa", "btn-primary", async () => {
      renderWorkflowDetail(await api("/api/workflows/" + encodeURIComponent(workflow.id) + "/advance", { method: "POST", body: {} }));
      await loadWorkflows();
      showNotice("A solicitação de avanço foi processada.", "success");
    }));
  }
  if (workflow.status === "RECOVERY_REQUIRED") {
    const failed = workflow.steps.find(step => step.status === "FAILED"
      && workflow.steps.some(handler => handler.onFailureOf === step.id)
      && !workflow.recoveries?.some(entry => entry.stepId === step.id));
    if (failed) {
      const handler = workflow.steps.find(step => step.onFailureOf === failed.id);
      buttons.append(node("p", "hint",
        "A etapa " + failed.id + " falhou. Investigue o resultado externo antes de autorizar "
        + "o caminho " + handler.id + ". Nenhuma ação será repetida automaticamente."));
      buttons.append(makeButton("Confirmar investigação e autorizar recuperação", "btn-outline",
        async () => {
          if (!window.confirm("Você investigou a falha de " + failed.id
            + ", verificou possíveis efeitos externos e autoriza SOMENTE preparar "
            + "a etapa alternativa " + handler.id + "? Ela não será executada agora.")) return;
          const note = window.prompt(
            "Descreva o que foi verificado (mínimo 10 caracteres). Não inclua senhas nem dados sensíveis:"
          );
          if (note === null) return;
          if (note.trim().length < 10 || note.length > 500) {
            throw new Error("Informe uma justificativa de 10 a 500 caracteres.");
          }
          renderWorkflowDetail(await api(
            "/api/workflows/" + encodeURIComponent(workflow.id) + "/recovery",
            { method: "POST", body: { stepId: failed.id, confirmed: true, note } }
          ));
          await loadWorkflows();
          showNotice(
            "Recuperação autorizada, sem executar nenhuma ferramenta. "
            + "Revise o caminho alternativo e use Avançar etapa quando decidir.",
            "success"
          );
        }));
    }
  }
  if (workflow.status === "AWAITING_APPROVAL") {
    const step = workflow.steps.find(s => s.status === "WAITING_APPROVAL");
    if (step && step.approvalId) {
      buttons.append(makeButton("Aprovar solicitação", "btn-outline", async () => {
        if (!window.confirm("Confirma a aprovação de " + step.tool + "? A aprovação permite uma execução posterior.")) return;
        await api("/api/approvals/" + encodeURIComponent(step.approvalId) + "/approve", { method: "POST", body: {} });
        showNotice("Solicitação aprovada. Agora escolha 'Executar etapa aprovada'.", "success");
      }));
      buttons.append(makeButton("▶ Executar etapa aprovada", "btn-primary", async () => {
        renderWorkflowDetail(await api("/api/workflows/" + encodeURIComponent(workflow.id) + "/advance", { method: "POST", body: { approvalId: step.approvalId } }));
        await loadWorkflows();
        showNotice("A execução aprovada foi processada.", "success");
      }));
    }
  }
  if (workflow.status === "NEEDS_RECONCILIATION") {
    const step = workflow.steps.find(s => s.status === "RUNNING");
    if (step) {
      buttons.append(node("p", "hint", "Verifique primeiro o resultado externo. Não execute novamente sem confirmação."));
      const reconcile = async outcome => {
        const question = outcome === "completed"
          ? "Você verificou EXTERNAMENTE que a etapa " + step.id + " foi concluída?"
          : "Você verificou EXTERNAMENTE que a etapa " + step.id + " não foi concluída?";
        if (!window.confirm(question)) return;
        renderWorkflowDetail(await api("/api/workflows/" + encodeURIComponent(workflow.id) + "/reconcile", {
          method: "POST", body: { stepId: step.id, outcome, confirmed: true }
        }));
        await loadWorkflows();
        showNotice("Resultado registrado por confirmação manual.", "success");
      };
      buttons.append(makeButton("Confirmar concluída", "btn-outline", () => reconcile("completed")));
      buttons.append(makeButton("Confirmar falhou", "btn-ghost", () => reconcile("failed")));
    }
  }
  buttons.append(makeButton("✦ Resumir no NEURON", "btn-ghost",
    () => askWorkflowStatus(workflow.id)));
  if (buttons.childNodes.length) target.append(buttons);
  target.append(headline("Etapas do processo"));
  workflow.steps.forEach(step => target.append(stepView(step)));
}

// Persisted tasks
$("#refresh-tasks").addEventListener("click", event => action(loadTasks, event.currentTarget));
function renderTaskList() {
  const target = clear($("#task-list"));
  if (!state.tasks.length) { target.append(info("Nenhum plano persistido foi encontrado.")); return; }
  state.tasks.forEach(task => {
    const button = node("button", "resource-row" + (state.taskId === task.id ? " selected" : ""));
    button.type = "button";
    const top = node("div", "row-head");
    top.append(node("strong", "", task.plan ? task.plan.objective : task.id), statusPill(task.plan?.status || "error"));
    button.append(top, node("div", "row-meta", dateTime(task.updatedAt)));
    button.addEventListener("click", () => action(async () => {
      state.taskId = task.id;
      renderTaskList();
      renderTaskDetail(await api("/api/tasks/" + encodeURIComponent(task.id)));
    }, button));
    target.append(button);
  });
}
function renderTaskDetail(task) {
  const target = clear($("#task-detail"));
  if (!task.plan) { target.append(info("O plano persistido está inválido.")); return; }
  target.append(node("h3", "detail-title", task.plan.objective));
  const meta = node("div", "detail-meta");
  meta.append(statusPill(task.plan.status), node("span", "row-meta", "Revisão " + task.plan.revision));
  target.append(meta, node("p", "row-meta", "ID: " + task.id));
  const controls = node("div", "actions");
  const pending = task.plan.steps.find(s => s.status === "AWAITING_APPROVAL");
  const ambiguous = task.plan.steps.find(s => s.status === "PLANNED");
  const resumable = task.plan.status !== "COMPLETED" && task.plan.status !== "FAILED";
  if (resumable && pending && pending.approvalId) {
    controls.append(makeButton("Aprovar solicitação", "btn-outline", async () => {
      if (!window.confirm("Confirma aprovação de " + pending.tool + "?")) return;
      await api("/api/approvals/" + encodeURIComponent(pending.approvalId) + "/approve", { method: "POST", body: {} });
      showNotice("Aprovação registrada. Agora retome o plano.", "success");
    }));
    controls.append(makeButton("▶ Retomar aprovada", "btn-primary", () => resumeTask(task.id, pending.approvalId)));
  } else if (resumable && !ambiguous) {
    controls.append(makeButton("▶ Retomar tarefa", "btn-primary", () => resumeTask(task.id)));
  }
  if (resumable && ambiguous) {
    controls.append(info("Existe uma execução de resultado incerto. Confirme externamente antes de reconciliar."));
    const reconcile = async outcome => {
      if (!window.confirm("Você conferiu EXTERNAMENTE o resultado real deste passo?")) return;
      await api("/api/tasks/" + encodeURIComponent(task.id) + "/reconcile", {
        method: "POST", body: { outcome, confirmed: true }
      });
      const updated = await api("/api/tasks/" + encodeURIComponent(task.id));
      renderTaskDetail(updated);
      await loadTasks();
      showNotice("Reconciliação realizada.", "success");
    };
    controls.append(makeButton("Confirmar concluída", "btn-outline", () => reconcile("completed")));
    controls.append(makeButton("Confirmar falha", "btn-ghost", () => reconcile("failed")));
  }
  if (controls.childNodes.length) target.append(controls);
  target.append(headline("Etapas salvas"), prettyBlock(task.plan.steps));
}
async function resumeTask(id, approvalId) {
  const payload = approvalId ? { approvalId } : { message: "Continue a tarefa preservando o objetivo original." };
  const result = await api("/api/tasks/" + encodeURIComponent(id) + "/resume", { method: "POST", body: payload });
  state.lastChat = result;
  renderChatInspection(result);
  const selected = await api("/api/tasks/" + encodeURIComponent(id));
  renderTaskDetail(selected);
  await loadTasks();
  showNotice(result.text || "Tarefa retomada.", "success");
}

// Tools
$("#refresh-tools").addEventListener("click", event => action(loadTools, event.currentTarget));
function renderTools() {
  const target = clear($("#tools-list"));
  if (!state.tools.length) { target.append(info("Nenhuma ferramenta registrada foi encontrada.")); return; }
  state.tools.forEach(tool => {
    const card = node("div", "tool-card");
    card.append(node("div", "tool-symbol", "⌘"), node("strong", "", tool.name), node("p", "", tool.description || "Sem descrição."));
    const meta = node("div", "tool-meta");
    meta.append(statusPill(tool.risk));
    meta.append(node("span", "row-meta", "v" + (tool.version || "—")));
    card.append(meta);
    if (tool.permissions?.length) card.append(node("p", "hint", "Permissões: " + tool.permissions.join(", ")));
    target.append(card);
  });
}

resetExample();
action(refreshAll);
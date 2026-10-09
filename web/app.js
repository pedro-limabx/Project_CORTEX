"use strict";

// The startup video is presentation only. It never controls authentication,
// APIs or backend tasks, and cannot trap users if autoplay/media fails.
function startCortexSplash() {
  const splash = document.querySelector("#cortex-splash");
  const video = document.querySelector("#cortex-splash-video");
  const fallback = document.querySelector("#cortex-splash-fallback");
  const skip = document.querySelector("#cortex-splash-skip");
  if (!splash || !video || !skip) return;

  document.querySelectorAll("[data-cortex-logo]").forEach(image => {
    image.addEventListener("error", () => { image.hidden = true; });
    if (image.complete && image.naturalWidth === 0) image.hidden = true;
  });

  let finished = false;
  let watchdog;
  let fallbackTimer;
  function finish() {
    if (finished) return;
    finished = true;
    window.clearTimeout(watchdog);
    window.clearTimeout(fallbackTimer);
    video.pause();
    splash.hidden = true;
    document.body.classList.remove("cortex-opening");
  }
  function showFallback() {
    if (finished) return;
    video.hidden = true;
    if (fallback) fallback.hidden = false;
    fallbackTimer = window.setTimeout(finish, 1800);
  }
  skip.addEventListener("click", finish, {once: true});
  video.addEventListener("ended", finish, {once: true});
  video.addEventListener("error", showFallback, {once: true});
  // Owner explicitly requests intro at every page entry. Skip remains available
  // so the animation is always optional to watch.

  splash.hidden = false;
  document.body.classList.add("cortex-opening");
  watchdog = window.setTimeout(finish, 15_000);
  video.muted = true; // Required for reliable autoplay on modern browsers.
  try {
    const playing = video.play();
    if (playing && typeof playing.catch === "function") playing.catch(showFallback);
  } catch {
    showFallback();
  }
}
startCortexSplash();
document.querySelector("#replay-intro")?.addEventListener("click", () => window.location.reload());

// Interface experimental. Nenhum token é persistido, e todo texto remoto usa textContent.
const state = {
  token: "",
  workflows: [],
  tasks: [],
  tools: [],
  workflowId: null,
  taskId: null,
  lastChat: null,
  monitoring: null,
  monitorLimit: 50,
  alerts: null,
  alertsLimit: 50,
  alertsView: "unread",
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
  DUE: "Vencido",
  DONE: "Concluído",
  CANCELLED: "Cancelado",
  PAUSED: "Pausado",
  ACTIVE: "Ativo",
  SKIPPED: "Ignorada",
  RUNNING: "Executando",
  PLANNED: "Planejado",
  PENDING_REVIEW: "Aguardando revisão",
  APPROVED: "Plano aprovado",
  REJECTED: "Plano rejeitado",
  EXPIRED: "Expirado"
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
    overview: "Visão geral", monitoring: "Monitoramento", alerts: "Alertas", reminders: "Lembretes", "google-calendar":"Google Agenda", chat: "NEURON Chat",
    "agenda-proposals":"Propostas de agenda",workflows: "Workflows v2", tasks: "Tarefas", tools: "Ferramentas"
  };
  if (!labels[name]) return;
  $$("[data-panel]").forEach(panel => { panel.hidden = panel.dataset.panel !== name; });
  $$(".nav-button").forEach(button => button.classList.toggle("active", button.dataset.tab === name));
  $("#page-name").textContent = labels[name];
  hideNotice();
  if (name === "monitoring") action(loadMonitoring);
  if (name === "alerts") action(loadAlertCenter);
  if (name === "reminders") action(loadReminders);
  if (name === "google-calendar") action(loadGoogleCalendarStatus);
  if (name === "agenda-proposals") action(loadAgendaProposals);
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
async function loadMonitoring() {
  const result = await api("/api/monitoring/overview?limit=" + state.monitorLimit);
  state.monitoring = result;
  renderMonitoring(result);
}

// CORTEX v9: opt-in, tab-local polling. The server does not schedule or
// dispatch notifications. Browser permission alone does not start polling.
let alertWatchTimer = null;
let browserAlertsEnabled = false;
let alertSnapshotInitialized = false;
let alertRequest = null;
const observedAlertKeys = new Set();

function operationalAlertKey(alert) {
  return alert.workflowId + ":" + alert.version + ":" + alert.status;
}

// Pure except for the explicitly supplied Set, allowing deterministic tests.
function selectNewOperationalAlerts(snapshot, known, hasBaseline) {
  const current = snapshot.alerts.filter(alert => !alert.acknowledged);
  const fresh = hasBaseline
    ? current.filter(alert => !known.has(operationalAlertKey(alert)))
    : [];
  snapshot.alerts.forEach(alert => known.add(operationalAlertKey(alert)));
  // Bound the page-local deduplication state.
  while (known.size > 500) known.delete(known.values().next().value);
  return fresh.slice(0, 3);
}

function updateAlertWatchControls() {
  $("#alerts-watch-toggle").textContent = alertWatchTimer === null
    ? "Iniciar acompanhamento (60 s)" : "Parar acompanhamento";
  $("#alerts-browser-toggle").textContent = browserAlertsEnabled
    ? "Desativar avisos do navegador" : "Permitir avisos do navegador";
  $("#alerts-watch-status").textContent = alertWatchTimer === null
    ? "Acompanhamento automático desligado. Você ainda pode consultar os alertas manualmente."
    : "Atualização nesta aba a cada 60 segundos. Avisos do navegador "
      + (browserAlertsEnabled ? "ativados." : "desativados.");
}

function notifyNewOperationalAlerts(alerts) {
  if (!browserAlertsEnabled || alertWatchTimer === null ||
      !("Notification" in window) || window.Notification.permission !== "granted") return;
  for (const alert of alerts) {
    try {
      // Intentionally generic: OS notifications can be visible on a lock screen.
      const notification = new window.Notification("CORTEX · Novo alerta operacional", {
        body: alert.severity === "critical"
          ? "Há um problema que precisa ser verificado. Abra a Central de Alertas."
          : "Um workflow requer atenção. Abra a Central de Alertas.",
        tag: "cortex-" + alert.status
      });
      notification.onclick = () => {
        window.focus();
        tab("alerts");
        notification.close();
      };
    } catch {
      // Ignore notification UI failures. The in-app inbox remains available.
    }
  }
}

async function loadAlerts() {
  if (alertRequest) return alertRequest;
  const task = (async () => {
    const path = "/api/alerts?limit=" + state.alertsLimit
      + "&view=" + encodeURIComponent(state.alertsView);
    const result = await api(path);
    const fresh = selectNewOperationalAlerts(
      result, observedAlertKeys, alertSnapshotInitialized
    );
    alertSnapshotInitialized = true;
    state.alerts = result;
    renderAlerts(result);
    notifyNewOperationalAlerts(fresh);
    return result;
  })();
  alertRequest = task;
  try {
    return await task;
  } finally {
    alertRequest = null;
  }
}

async function refreshAll() {
  await checkHealth();
  const results = await Promise.allSettled([loadTools(), loadWorkflows(), loadTasks(), loadMonitoring(), loadAlerts(), loadBackendCenter()]);
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

// CORTEX v7: read-only operational monitoring.
const monitorStatuses = [
  "NEEDS_RECONCILIATION", "FAILED", "RECOVERY_REQUIRED", "AWAITING_APPROVAL",
  "RECOVERING", "ACTIVE", "COMPLETED_WITH_FAILURES", "COMPLETED"
];
const monitorStepStatuses = [
  "COMPLETED", "SKIPPED", "FAILED", "WAITING_APPROVAL", "RUNNING", "PENDING"
];

function monitorDuration(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return Math.round(ms) + " ms";
  if (ms < 60000) return (ms / 1000).toFixed(1) + " s";
  return (ms / 60000).toFixed(1) + " min";
}

async function openMonitoredWorkflow(id) {
  state.workflowId = id;
  tab("workflows");
  // Called from makeButton's action wrapper. The tab's background loader is
  // blocked by state.busy here, so explicitly load the selected workflow.
  await loadWorkflows();
}

function renderMonitoring(snapshot) {
  $("#monitor-scope").textContent =
    "Atualizado em " + dateTime(snapshot.generatedAt) + " · " +
    snapshot.scope.sampled + " workflows entre os últimos " + snapshot.scope.limit +
    " consultados. Números da amostra, não de todo o histórico.";
  $("#monitor-total").textContent = String(snapshot.metrics.total);
  $("#monitor-completed").textContent = String(snapshot.metrics.completed);
  $("#monitor-completed-hint").textContent =
    snapshot.metrics.completionPercent == null
      ? "Sem amostra para calcular percentual"
      : snapshot.metrics.completionPercent + "% da amostra finalizada (inclui recuperações)";
  $("#monitor-attention").textContent = String(snapshot.metrics.requiringAttention);
  $("#monitor-critical-hint").textContent =
    snapshot.metrics.critical + " casos críticos · Contagem da amostra";
  $("#monitor-duration").textContent = monitorDuration(snapshot.metrics.averageTerminalStepDurationMs);
  $("#monitor-duration-hint").textContent =
    snapshot.metrics.observedTerminalStepDurations + " etapas com duração verificável";

  const statusTarget = clear($("#monitor-status-distribution"));
  if (!snapshot.metrics.total) {
    statusTarget.append(info("Nenhum workflow encontrado nesta amostra."));
  } else {
    monitorStatuses.forEach(status => {
      const count = snapshot.statusCounts[status] || 0;
      const line = node("div", "monitor-bar-row");
      const head = node("div", "monitor-bar-head");
      head.append(node("span", "", statusLabels[status] || status),
        node("strong", "", String(count)));
      const track = node("div", "monitor-bar-track");
      const fill = node("div", "monitor-bar-fill " + status.toLowerCase());
      fill.style.width = (100 * count / snapshot.metrics.total) + "%";
      track.append(fill);
      line.append(head, track);
      statusTarget.append(line);
    });
  }

  const stepTarget = clear($("#monitor-step-counts"));
  monitorStepStatuses.forEach(status => {
    const entry = node("div", "monitor-step-count");
    entry.append(statusPill(status),
      node("strong", "", String(snapshot.metrics.steps[status] || 0)));
    stepTarget.append(entry);
  });

  const alertTarget = clear($("#monitor-alerts"));
  if (!snapshot.alerts.length) {
    alertTarget.append(info("Nenhum workflow da amostra exige atenção no momento."));
  }
  snapshot.alerts.forEach(alert => {
    const entry = node("div", "monitor-alert " + alert.severity);
    const header = node("div", "row-head");
    header.append(node("strong", "", alert.objective), statusPill(alert.status));
    entry.append(header,
      node("p", "", alert.message),
      node("p", "hint", alert.nextAction),
      node("p", "row-meta", "Atualizado: " + dateTime(alert.updatedAt)));
    entry.append(makeButton("Examinar workflow ↗", "btn-ghost small",
      () => openMonitoredWorkflow(alert.workflowId)));
    alertTarget.append(entry);
  });

  const activityTarget = clear($("#monitor-activity"));
  if (!snapshot.activity.length) {
    activityTarget.append(info("Sem eventos recentes registrados nesta amostra."));
  }
  snapshot.activity.forEach(event => {
    const entry = node("div", "monitor-activity-item");
    const label = workflowEventLabels[event.kind] || event.kind;
    entry.append(node("strong", "", label),
      node("p", "row-meta", dateTime(event.at) + " · " +
        (event.stepId ? "Etapa " + event.stepId : "Workflow") + " · " +
        ({ engine: "Motor", routing: "Desvio", operator: "Operador" }[event.source] || "Evento")));
    if (event.from && event.to) {
      entry.append(node("p", "row-meta",
        (statusLabels[event.from] || event.from) + " → " +
        (statusLabels[event.to] || event.to)));
    }
    entry.append(makeButton("Ver detalhes ↗", "btn-ghost small",
      () => openMonitoredWorkflow(event.workflowId)));
    activityTarget.append(entry);
  });

  const recentTarget = clear($("#monitor-recent"));
  if (!snapshot.recent.length) recentTarget.append(info("Nenhum workflow recente."));
  snapshot.recent.forEach(workflow => {
    const entry = node("div", "monitor-recent-item");
    const title = node("div", "row-head");
    title.append(node("strong", "", workflow.objective), statusPill(workflow.status));
    entry.append(title,
      node("p", "row-meta",
        workflow.percent + "% resolvido · " + workflow.completed + " concluídas · " +
        workflow.skipped + " ignoradas · " + workflow.failed + " falhas"),
      node("p", "row-meta", "Atualizado: " + dateTime(workflow.updatedAt)));
    entry.append(makeButton("Abrir workflow ↗", "btn-outline small",
      () => openMonitoredWorkflow(workflow.id)));
    recentTarget.append(entry);
  });
}

$("#refresh-monitoring").addEventListener("click",
  event => action(loadMonitoring, event.currentTarget));
$("#monitor-limit").addEventListener("change", event => {
  state.monitorLimit = Number(event.currentTarget.value);
  void action(loadMonitoring);
});

// CORTEX v8 — explicit, on-demand, owner-scoped alert triage.
function alertMessageForManualShare(alert) {
  // Deliberately exclude the user-authored objective and all stored payloads.
  // The operator chooses whether and where to send this text; CORTEX never sends.
  return [
    "CORTEX — Alerta operacional (preparado manualmente)",
    "Workflow: " + alert.workflowId,
    "Estado: " + (statusLabels[alert.status] || alert.status),
    "Classificação: " + (alert.severity === "critical" ? "Crítico" : "Atenção"),
    "Situação: " + alert.message,
    "Próxima ação sugerida: " + alert.nextAction,
    "Este aviso não comprova conclusão ou execução de ferramentas."
  ].join("\n");
}

function renderAlerts(snapshot) {
  $("#alerts-scope").textContent = "Consultado em " + dateTime(snapshot.generatedAt)
    + " · " + snapshot.scope.sampled + " workflows dentre os últimos "
    + snapshot.scope.limit + " examinados. Recorte recente, não histórico total.";
  $("#alerts-total").textContent = String(snapshot.counts.all);
  $("#alerts-unread").textContent = String(snapshot.counts.unread);
  $("#alerts-seen").textContent = String(snapshot.counts.acknowledged);
  $("#alerts-critical").textContent = String(snapshot.counts.critical);
  const badge = $("#nav-alert-count");
  badge.textContent = String(snapshot.counts.unread);
  badge.hidden = snapshot.counts.unread === 0;

  const target = clear($("#alerts-list"));
  if (!snapshot.alerts.length) {
    target.append(info(snapshot.counts.all === 0
      ? "Nenhum alerta foi identificado na amostra consultada."
      : "Não há alertas não vistos para os workflows consultados."));
    return;
  }
  snapshot.alerts.forEach(alert => {
    const entry = node("article", "operational-alert " + alert.severity
      + (alert.acknowledged ? " acknowledged" : ""));
    const header = node("div", "row-head");
    header.append(node("strong", "", alert.objective), statusPill(alert.status));
    entry.append(header);
    entry.append(node("p", "row-meta",
      (alert.severity === "critical" ? "Prioridade crítica" : "Requer atenção")
      + " · Versão " + alert.version + " · " + dateTime(alert.updatedAt)));
    entry.append(node("p", "", alert.message));
    entry.append(node("p", "hint", "Próxima ação: " + alert.nextAction));
    if (alert.acknowledged) {
      entry.append(node("p", "alert-acknowledged",
        "✓ Visto em " + dateTime(alert.acknowledgedAt)
        + " — o problema pode continuar pendente."));
    }
    const actions = node("div", "actions");
    actions.append(makeButton("Examinar workflow ↗", "btn-ghost small",
      () => openMonitoredWorkflow(alert.workflowId)));
    if (!alert.acknowledged) {
      actions.append(makeButton("✓ Marcar como visto", "btn-outline small", async () => {
        if (!window.confirm("Confirma que leu este alerta? Isso NÃO resolve a falha, "
          + "não aprova ferramentas nem altera o workflow.")) return;
        await api("/api/alerts/acknowledge", {
          method: "POST",
          body: {
            workflowId: alert.workflowId,
            version: alert.version,
            status: alert.status,
            confirmed: true
          }
        });
        await loadAlerts();
        showNotice("Leitura registrada. A operação do workflow não foi alterada.", "success");
      }));
    }
    actions.append(makeButton("Copiar aviso (não envia)", "btn-ghost small", async () => {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Seu navegador não permite copiar neste contexto seguro.");
      }
      await navigator.clipboard.writeText(alertMessageForManualShare(alert));
      showNotice("Aviso copiado. Nenhum e-mail ou mensagem foi enviado.", "success");
    }));
    entry.append(actions);
    target.append(entry);
  });
}

$("#refresh-alerts").addEventListener("click",
  event => action(loadAlertCenter, event.currentTarget));
$("#alerts-limit").addEventListener("change", event => {
  state.alertsLimit = Number(event.currentTarget.value);
  void action(loadAlerts);
});
$("#alerts-view").addEventListener("change", event => {
  state.alertsView = event.currentTarget.value;
  void action(loadAlerts);
});

$("#alerts-watch-toggle").addEventListener("click", event => action(async () => {
  if (alertWatchTimer !== null) {
    window.clearInterval(alertWatchTimer);
    alertWatchTimer = null;
    updateAlertWatchControls();
    return;
  }
  // Obtain a baseline before polling, so old incidents never trigger a
  // burst of browser notifications just because the user enabled watching.
  await loadAlerts();
  alertWatchTimer = window.setInterval(() => {
    void loadAlerts().catch(error => {
      showNotice("Não foi possível atualizar os alertas: " +
        (error instanceof Error ? error.message : "erro desconhecido"), "error");
    });
  }, 60000);
  updateAlertWatchControls();
}, event.currentTarget));

$("#alerts-browser-toggle").addEventListener("click", event => action(async () => {
  if (browserAlertsEnabled) {
    browserAlertsEnabled = false;
    updateAlertWatchControls();
    return;
  }
  if (!("Notification" in window)) {
    showNotice("Este navegador não oferece notificações locais.", "error");
    return;
  }
  // Request browser permission only as a direct consequence of a click.
  const permission = await window.Notification.requestPermission();
  if (permission !== "granted") {
    showNotice("Notificações não autorizadas. A caixa de alertas continua disponível.");
    return;
  }
  browserAlertsEnabled = true;
  updateAlertWatchControls();
  showNotice("Permissão concedida nesta aba. Ative o acompanhamento para receber novos avisos.", "success");
}, event.currentTarget));
updateAlertWatchControls();


// CORTEX V11: persistent inbox, diagnostics, and safe manual monitoring.
// Browser remains a presentation client; never schedules backend checks.
async function loadAlertCenter() {
  await Promise.all([loadAlerts(), loadBackendCenter()]);
}
function showBackendStatus(settings) {
  $("#backend-monitor-enabled").checked = settings.enabled;
  // Respect custom integer values set via API even when not in the presets.
  for (const [id, value] of [
    ["backend-monitor-interval", settings.intervalSeconds],
    ["backend-monitor-cooldown", settings.cooldownSeconds]
  ]) {
    const control = $("#" + id);
    if (![...control.options].some(option => Number(option.value) === value)) {
      const option = node("option", "", value + " segundos (personalizado)");
      option.value = String(value);
      control.append(option);
    }
    control.value = String(value);
  }
  $("#backend-monitor-status").textContent = settings.enabled
    ? "Ativo no backend · Última verificação: " + dateTime(settings.lastCheckedAt)
      + " · Próxima: " + dateTime(settings.nextCheckAt)
      + " · Resultado: " + (settings.lastCheckOk === null ? "sem histórico" : settings.lastCheckOk ? "OK" : "falhou")
    : "Desativado no servidor · Configuração preservada no PostgreSQL.";
}
function renderBackendHealth(health) {
  const labels = { disabled:"Desativado", starting:"Aguardando primeira verificação",
    healthy:"Funcionando", degraded:"Falha na última verificação", overdue:"Verificação atrasada" };
  $("#backend-monitor-health").textContent = "Diagnóstico: " + (labels[health.status] || "Indisponível")
    + " · Não lidas: " + health.unreadNotifications
    + (health.overdueSeconds > 30 ? " · Atraso: " + health.overdueSeconds + " s" : "");
}
function renderPersistentNotices(data) {
  $("#backend-notice-count").textContent = String(data.unread);
  const target = clear($("#backend-notice-list"));
  if (!data.notifications.length) {
    target.append(info("Nenhuma notificação persistente nesta seleção."));
    return;
  }
  data.notifications.forEach(notification => {
    const entry = node("article", "operational-alert " + notification.severity
      + (notification.readAt ? " acknowledged" : ""));
    const header = node("div", "row-head");
    header.append(node("strong", "", notification.severity === "critical"
      ? "Incidente que exige intervenção" : "Ação humana pendente"), statusPill(notification.status));
    entry.append(header, node("p", "row-meta",
      "Workflow " + notification.workflowId + " · Versão " + notification.version
      + " · " + dateTime(notification.createdAt)));
    if (notification.readAt) entry.append(node("p", "alert-acknowledged",
      "✓ Lida em " + dateTime(notification.readAt)));
    const buttons = node("div", "actions");
    buttons.append(makeButton("Examinar workflow ↗", "btn-ghost small",
      () => openMonitoredWorkflow(notification.workflowId)));
    if (!notification.readAt) {
      buttons.append(makeButton("✓ Marcar como lida", "btn-outline small", async () => {
        if (!window.confirm("Confirmar leitura? Isto não aprova, executa ou reconcilia nenhuma ação.")) return;
        await api("/api/notifications/" + encodeURIComponent(notification.id) + "/read", {
          method: "POST", body: { confirmed: true }
        });
        await loadBackendCenter();
        showNotice("Leitura persistida sem alterar o workflow.", "success");
      }));
    }
    entry.append(buttons);
    target.append(entry);
  });
}
function renderBackendEvents(events) {
  const target = clear($("#backend-events-list"));
  if (!events.length) { target.append(info("Ainda não existem verificações registradas.")); return; }
  const label = {
    SETTINGS_UPDATED: "Configuração alterada",
    CHECK_COMPLETED: "Verificação concluída",
    CHECK_FAILED: "Verificação falhou"
  };
  events.forEach(event => {
    const entry = node("div", "monitor-activity-item");
    entry.append(node("strong", "", label[event.kind] || "Evento"),
      node("p", "row-meta", dateTime(event.createdAt) + " · " +
        event.sampled + " workflows analisados · " + event.created + " novos alertas"));
    target.append(entry);
  });
}
async function loadBackendCenter() {
  const result = await api("/api/monitoring/backend");
  if (!result.available) {
    $("#backend-monitor-status").textContent =
      "Indisponível: configure DATABASE_URL e reinicie o servidor para habilitar a V10.";
    $("#backend-monitor-save").disabled = true;
    $("#backend-monitor-check").disabled = true;
    $("#backend-monitor-health").textContent = "Diagnóstico indisponível sem PostgreSQL.";
    clear($("#backend-notice-list")).append(info("PostgreSQL não está configurado."));
    clear($("#backend-events-list"));
    $("#backend-notice-count").textContent = "—";
    return;
  }
  $("#backend-monitor-save").disabled = false;
  $("#backend-monitor-check").disabled = !result.settings.enabled;
  showBackendStatus(result.settings);
  const view = $("#backend-notice-view").value;
  const [notices, history, health] = await Promise.all([
    api("/api/notifications?view=" + encodeURIComponent(view) + "&limit=50"),
    api("/api/monitoring/backend/events?limit=12"),
    api("/api/monitoring/backend/health")
  ]);
  renderPersistentNotices(notices);
  renderBackendEvents(history.events || []);
  renderBackendHealth(health);
}
$("#backend-monitor-save").addEventListener("click", event => action(async () => {
  const config = {
    enabled: $("#backend-monitor-enabled").checked,
    intervalSeconds: Number($("#backend-monitor-interval").value),
    cooldownSeconds: Number($("#backend-monitor-cooldown").value)
  };
  await api("/api/monitoring/backend", { method: "PUT", body: config });
  await loadBackendCenter();
  showNotice("Configuração persistida no servidor. Nenhuma ferramenta foi executada.", "success");
}, event.currentTarget));
$("#backend-monitor-check").addEventListener("click", event => action(async () => {
  const result = await api("/api/monitoring/backend/check", {method:"POST",body:{confirmed:true}});
  await loadBackendCenter();
  const reasons = {disabled:"monitor desativado",rate_limited:"aguarde 30 segundos da última verificação",
    locked:"outra instância está verificando",not_due:"ainda não chegou o intervalo"};
  showNotice(result.ran
    ? "Verificação concluída: " + result.sampled + " workflows analisados, " + result.created + " notificações criadas."
    : "Verificação não realizada: " + (reasons[result.reason] || "indisponível") + ".",
    result.ran ? "success" : undefined);
}, event.currentTarget));
$("#backend-notice-refresh").addEventListener("click", event =>
  action(loadBackendCenter, event.currentTarget));
$("#backend-notice-view").addEventListener("change", () => void action(loadBackendCenter));

// V18 Google Calendar: optional read-only integration, never shares the
// NEURON Bearer token or exposes Google OAuth tokens to the browser.
async function loadGoogleCalendarStatus(){
  const status=await api("/api/integrations/google-calendar/status");
  const label=$("#google-calendar-status");
  if(!status.configured){
    label.textContent="Integração indisponível: "+(status.reason||"faltam credenciais OAuth.");
  }else{
    label.textContent=status.connected
      ?"Google Agenda conectado (somente leitura)."
      :"Google Agenda disponível para conexão; sua conta ainda não foi autorizada.";
  }
  $("#google-calendar-connect").hidden=!status.configured||status.connected;
  $("#google-calendar-disconnect").hidden=!status.connected;
  $("#google-calendar-events").disabled=!status.connected;
  if(status.connected)clear($("#google-calendar-auth-link"));
}
function formatGoogleEventDate(value,allDay){
  if(allDay)return value.split("-").reverse().join("/")+" · Dia inteiro";
  const date=new Date(value);
  return Number.isFinite(date.getTime())
    ?date.toLocaleString("pt-BR",{
      timeZone:"America/Sao_Paulo",dateStyle:"short",timeStyle:"short"
    })+" · São Paulo":String(value);
}
async function loadGoogleEvents(){
  const period=$("#google-calendar-period").value;
  if(!["today","tomorrow","week"].includes(period))throw new Error("Período inválido");
  const data=await api("/api/integrations/google-calendar/events?period="+encodeURIComponent(period));
  const list=clear($("#google-calendar-event-list"));
  $("#google-calendar-event-status").textContent=data.events.length+
    " evento(s) do Google consultado(s). "+(data.truncated
      ?"O resultado foi limitado; podem existir mais eventos.":"");
  if(!data.events.length){list.append(info("Nenhum evento neste período."));return;}
  for(const event of data.events){
    const card=node("div","resource-row");
    card.append(node("strong","",event.title),
      node("p","row-meta",formatGoogleEventDate(event.start,event.allDay)));
    list.append(card);
  }
}
$("#google-calendar-connect").addEventListener("click",event=>action(async()=>{
  if(!window.confirm("Deseja autorizar o CORTEX a CONSULTAR seus eventos do Google Agenda? "+
    "A conexão não permitirá criar, editar ou excluir eventos."))return;
  const data=await api("/api/integrations/google-calendar/connect",{method:"POST",body:{}});
  const url=new URL(data.authorizationUrl);
  if(url.origin!=="https://accounts.google.com"||url.pathname!=="/o/oauth2/v2/auth")
    throw new Error("Endereço de autorização inesperado.");
  const anchor=node("a","btn btn-primary","Continuar no Google ↗");
  anchor.href=url.toString();
  anchor.target="_blank";
  anchor.rel="noopener noreferrer";
  const target=clear($("#google-calendar-auth-link"));
  target.append(node("p","hint","Abra o link abaixo e autorize no Google. Depois retorne e clique em Verificar conexão."),anchor);
  $("#google-calendar-status").textContent="Autorização preparada. Ela expira em 10 minutos.";
},event.currentTarget));
$("#google-calendar-refresh").addEventListener("click",event=>action(
  loadGoogleCalendarStatus,event.currentTarget));
$("#google-calendar-events").addEventListener("click",event=>action(
  loadGoogleEvents,event.currentTarget));
$("#google-calendar-disconnect").addEventListener("click",event=>action(async()=>{
  if(!window.confirm("Remover os tokens Google salvos pelo CORTEX? "+
    "Isso não revoga o consentimento diretamente na Conta Google."))return;
  await api("/api/integrations/google-calendar/disconnect",{
    method:"POST",body:{confirmed:true}
  });
  clear($("#google-calendar-event-list"));
  $("#google-calendar-event-status").textContent="Conexão local removida.";
  clear($("#google-calendar-auth-link"));
  await loadGoogleCalendarStatus();
  showNotice("Tokens Google locais removidos. Revogue também o consentimento no Google, se desejar.","success");
},event.currentTarget));

// V22: local plan decisions. No Google event changes are performed here.
async function loadAgendaProposals(){
  const response=await api("/api/agenda/proposals?limit=50");
  const list=clear($("#agenda-proposals-list"));
  $("#agenda-proposals-status").textContent=response.proposals.length+
    " proposta(s) · nenhuma mudança externa aplicada.";
  if(!response.proposals.length){
    list.append(info("Nenhuma proposta ainda. Analise conflitos no NEURON Chat."));
    return;
  }
  for(const plan of response.proposals){
    const entry=node("article","recurrence-item");
    const head=node("div","row-head");
    head.append(node("strong","",plan.title),
      statusPill(plan.expired?"EXPIRED":plan.status));
    entry.append(head);
    entry.append(node("p","row-meta","Origem: "+
      (plan.source==="google"?"Google Agenda":"CORTEX")+
      " · plano para revisão"));
    entry.append(node("p","row-meta","Original: "+dateTime(plan.originalStart)+
      (plan.originalEnd?" a "+dateTime(plan.originalEnd):" · pontual")));
    entry.append(node("p","row-meta","Alternativa: "+dateTime(plan.proposedStart)+
      (plan.proposedEnd?" a "+dateTime(plan.proposedEnd):" · pontual")));
    entry.append(node("p","hint","Validade: "+dateTime(plan.expiresAt)+
      " · não altera compromissos"));
    const actions=node("div","actions");
    if(plan.status==="PENDING_REVIEW"&&!plan.expired){
      for(const [label,decision] of [["Aprovar plano","approve"],["Rejeitar","reject"]]){
        actions.append(makeButton(label,"btn-outline small",async()=>{
          const prompt=decision==="approve"
            ?"Confirmar APROVAÇÃO apenas da proposta? Não moveremos eventos ou lembretes."
            :"Confirmar REJEIÇÃO desta proposta?";
          if(!window.confirm(prompt))return;
          await api("/api/agenda/proposals/"+encodeURIComponent(plan.id)+
            "/"+decision,{method:"POST",body:{confirmed:true}});
          await loadAgendaProposals();
          showNotice("Decisão registrada. Nenhum compromisso foi alterado.","success");
        }));
      }
    }
    entry.append(actions);
    list.append(entry);
  }
}
$("#refresh-agenda-proposals").addEventListener("click",event=>action(
  loadAgendaProposals,event.currentTarget));
async function prepareAgendaProposal(period,conflictKey,targetId){
  if(!window.confirm("Criar proposta local para esse compromisso? "+
    "O NEURON consultará a agenda novamente e NÃO alterará eventos ou lembretes."))return;
  const response=await api("/api/agenda/proposals",{method:"POST",body:{
    period,conflictKey,targetId,confirmed:true
  }});
  await loadAgendaProposals();
  tab("agenda-proposals");
  showNotice("Proposta "+response.proposal.id+" registrada para revisão.","success");
}

// V21 shortcut: send only after click, and never overwrite an unfinished draft.
$("#chat-conflicts-tomorrow").addEventListener("click",()=>{
  tab("chat");
  if(chatSending){showNotice("Aguarde a consulta atual.");return;}
  const input=$("#message");
  if(input.value.trim()){
    showNotice("Há um rascunho não enviado. Envie ou apague antes de verificar conflitos.");
    input.focus();return;
  }
  input.value="Tenho conflitos na agenda amanhã?";
  void sendChatMessage();
});

// V20 quick unified agenda query: optional Google account, no discarded drafts.
$("#chat-unified-today").addEventListener("click",()=>{
  tab("chat");
  if(chatSending){
    showNotice("Aguarde a resposta atual do NEURON.");
    return;
  }
  const input=$("#message");
  if(input.value.trim()){
    showNotice("Há um rascunho não enviado. Envie ou apague antes da consulta unificada.");
    input.focus();
    return;
  }
  input.value="Minha agenda completa de hoje";
  void sendChatMessage();
});

// V17: manual calendar export with in-memory Bearer token. Never expose a
// token in URLs, anchor hrefs, logs or persistent browser storage.
async function downloadAgendaIcs(period) {
  if (!["today","tomorrow","week"].includes(period)) {
    throw new Error("Selecione um período válido para a exportação.");
  }
  if (!window.confirm("Exportar os títulos e horários dos seus lembretes para um arquivo .ics? "+
    "O arquivo ficará no dispositivo e poderá ser lido por outros aplicativos. "+
    "A importação não terá sincronização automática.")) return;
  const headers={Accept:"text/calendar"};
  if(state.token)headers.Authorization="Bearer "+state.token;
  const response=await fetch("/api/agenda/export?period="+encodeURIComponent(period),{
    method:"GET",headers,credentials:"same-origin",cache:"no-store"
  });
  if(!response.ok){
    let details={};
    try{details=await response.json();}catch{/* avoid exposing server response body */}
    if(response.status===401)throw new Error("Informe um token CORTEX_API_TOKEN válido.");
    throw new Error(details.error||"Falha na exportação HTTP "+response.status);
  }
  if(!(response.headers.get("content-type")||"").includes("text/calendar")){
    throw new Error("O servidor não retornou um calendário válido.");
  }
  const file=await response.blob();
  const objectUrl=URL.createObjectURL(file);
  try{
    const link=document.createElement("a");
    link.href=objectUrl;
    link.download="cortex-agenda-"+period+".ics";
    link.style.display="none";
    document.body.append(link);
    link.click();
    link.remove();
  }finally{
    // Browser download may start asynchronously, so revoke after a short delay.
    window.setTimeout(()=>URL.revokeObjectURL(objectUrl),30000);
  }
  showNotice("Arquivo .ics preparado. Importe-o manualmente no aplicativo de calendário.","success");
}
$("#export-calendar").addEventListener("click",event=>action(
  ()=>downloadAgendaIcs($("#agenda-export-period").value),event.currentTarget));

// CORTEX V14: opt-in browser watch. The durable scheduler remains on the server.
let reminderWatchTimer = null;
let browserRemindersEnabled = false;
let reminderWatchStartedAt = 0;
let reminderWatchSeen = new Set();
let reminderWatchInFlight = false;

function updateReminderBadge(count) {
  const badge = $("#nav-reminder-count");
  badge.textContent = String(count);
  badge.hidden = count === 0;
}
function selectNewDueReminders(reminders, seen, startedAt) {
  const fresh = [];
  for (const reminder of reminders) {
    if (reminder?.status !== "DUE" || typeof reminder.id !== "string" || !reminder.id
        || seen.has(reminder.id)) continue;
    seen.add(reminder.id);
    // Never notify a backlog just because the user enabled monitoring.
    const at = Date.parse(reminder.triggeredAt || "");
    if (Number.isFinite(at) && at >= startedAt) fresh.push(reminder);
  }
  return fresh;
}
function updateReminderWatchControls() {
  const active = reminderWatchTimer !== null;
  $("#reminder-watch-toggle").textContent = active ? "■ Desativar acompanhamento" : "▶ Ativar acompanhamento";
  $("#reminder-watch-toggle").setAttribute("aria-pressed",String(active));
  $("#reminder-browser-toggle").textContent = browserRemindersEnabled
    ? "🔕 Desativar avisos do navegador" : "🔔 Ativar avisos do navegador";
  $("#reminder-browser-toggle").setAttribute("aria-pressed",String(browserRemindersEnabled));
  $("#reminder-watch-status").textContent = !active
    ? "Acompanhamento desativado. Nenhum aviso do navegador será emitido."
    : "Verificação a cada 30 segundos nesta aba · Avisos do navegador "
      + (browserRemindersEnabled ? "ativados" : "desativados") + " · sem notificações push.";
}
function notifyNewDueReminders(reminders) {
  if (!reminders.length || !browserRemindersEnabled || reminderWatchTimer === null
      || !("Notification" in window) || window.Notification.permission !== "granted") return;
  try {
    // Never put the private reminder title/description in OS notifications.
    const notification = new window.Notification("CORTEX — Lembrete vencido", {
      body: reminders.length === 1
        ? "Você tem um lembrete para consultar no painel."
        : "Você tem " + reminders.length + " lembretes novos para consultar no painel.",
      tag:"cortex-reminders",silent:true
    });
    notification.onclick = () => {
      window.focus();
      tab("reminders");
      notification.close();
    };
  } catch {
    // Browser notifications may be blocked by OS/site policy; UI stays usable.
  }
}
async function pollDueReminders() {
  if (reminderWatchTimer === null || reminderWatchInFlight) return;
  reminderWatchInFlight = true;
  try {
    const snapshot = await api("/api/reminders?view=due&limit=100");
    if (reminderWatchTimer === null) return;
    updateReminderBadge(snapshot.due);
    const fresh = selectNewDueReminders(snapshot.reminders,reminderWatchSeen,reminderWatchStartedAt);
    if (!fresh.length) return;
    $("#reminder-watch-status").textContent = fresh.length
      + " novo(s) lembrete(s) vencido(s). Consulte a agenda para visualizar.";
    notifyNewDueReminders(fresh);
  } finally {
    reminderWatchInFlight = false;
  }
}
$("#reminder-watch-toggle").addEventListener("click",event=>action(async()=>{
  if (reminderWatchTimer !== null) {
    window.clearInterval(reminderWatchTimer);
    reminderWatchTimer = null;
    reminderWatchSeen.clear();
    updateReminderWatchControls();
    return;
  }
  const snapshot = await api("/api/reminders?view=due&limit=100");
  reminderWatchSeen = new Set(snapshot.reminders
    .filter(x=>x.status==="DUE" && typeof x.id==="string").map(x=>x.id));
  reminderWatchStartedAt = Date.now();
  updateReminderBadge(snapshot.due);
  reminderWatchTimer = window.setInterval(()=>{
    void pollDueReminders().catch(error=>{
      $("#reminder-watch-status").textContent = "Falha na consulta: "
        + (error instanceof Error ? error.message : "erro desconhecido");
    });
  },30000);
  updateReminderWatchControls();
},event.currentTarget));
$("#reminder-browser-toggle").addEventListener("click",event=>action(async()=>{
  if (browserRemindersEnabled) {
    browserRemindersEnabled = false;
    updateReminderWatchControls();
    return;
  }
  if (!("Notification" in window) || !window.isSecureContext) {
    showNotice("Avisos do navegador exigem um navegador compatível e contexto seguro (HTTPS ou localhost).","error");
    return;
  }
  // Permission only from a user click, never from startup/background polling.
  const permission = await window.Notification.requestPermission();
  if (permission !== "granted") {
    showNotice("O navegador não autorizou avisos. Os lembretes continuam disponíveis no painel.");
    return;
  }
  browserRemindersEnabled = true;
  updateReminderWatchControls();
  showNotice("Avisos autorizados nesta aba. Ative o acompanhamento para recebê-los.","success");
},event.currentTarget));
updateReminderWatchControls();

// CORTEX V15: recurring schedules in the same owner-scoped Postgres instance.
const weekdayLabels=["Domingo","Segunda-feira","Terça-feira","Quarta-feira",
  "Quinta-feira","Sexta-feira","Sábado"];
async function loadRecurringSchedules(){
  const snapshot=await api("/api/reminder-schedules?limit=100");
  const list=clear($("#recurrence-list"));
  $("#recurrence-status").textContent=snapshot.schedules.length+
    " recorrência(s) · Horários em São Paulo · Sem geração de tarefas externas.";
  if(!snapshot.schedules.length){
    list.append(info("Você ainda não criou nenhuma recorrência."));
    return;
  }
  for(const item of snapshot.schedules){
    const entry=node("article","recurrence-item");
    const head=node("div","row-head");
    head.append(node("strong","",item.title),statusPill(item.status));
    entry.append(head,node("p","row-meta",
      (item.frequency==="DAILY"?"Todos os dias":weekdayLabels[item.weekday]??"Semanal")
      +" às "+item.localTime+" · São Paulo"));
    if(item.status==="ACTIVE")entry.append(node("p","hint",
      "Próxima ocorrência: "+dateTime(item.nextDueAt)));
    if(item.status==="PAUSED")entry.append(node("p","hint",
      "Pausado · A próxima ocorrência será recalculada ao retomar."));
    if(item.status==="CANCELLED")entry.append(node("p","hint","Cancelado definitivamente."));
    const actions=node("div","actions");
    for(const [label,actionName] of item.status==="ACTIVE"
      ?[["Pausar","pause"],["Cancelar","cancel"]]
      :item.status==="PAUSED"
        ?[["Retomar","resume"],["Cancelar","cancel"]]:[]){
      actions.append(makeButton(label,"btn-outline small",async()=>{
        if(!window.confirm("Confirma "+label.toLowerCase()+" esta recorrência? "+
          "As ocorrências anteriores permanecerão no histórico."))return;
        await api("/api/reminder-schedules/"+encodeURIComponent(item.id)+
          "/"+actionName,{method:"POST",body:{confirmed:true}});
        await loadReminders();
        showNotice("Recorrência atualizada.","success");
      }));
    }
    entry.append(actions);
    list.append(entry);
  }
}
$("#recurrence-frequency").addEventListener("change",()=>{
  $("#recurrence-weekday-wrap").hidden=$("#recurrence-frequency").value!=="WEEKLY";
});
$("#recurrence-form").addEventListener("submit",event=>{
  event.preventDefault();
  void action(async()=>{
    const frequency=$("#recurrence-frequency").value;
    const body={title:$("#recurrence-title").value.trim(),
      frequency,time:$("#recurrence-time").value,
      ...(frequency==="WEEKLY"?{weekday:Number($("#recurrence-weekday").value)}:{})};
    await api("/api/reminder-schedules",{method:"POST",body});
    $("#recurrence-title").value="";
    await loadReminders();
    showNotice("Recorrência criada no PostgreSQL.","success");
  },$("#recurrence-form button[type=submit]"));
});

// CORTEX V12: explicitly scheduled one-time reminders, no browser timer required.
async function loadReminders() {
  const view = $("#reminder-view").value;
  const response = await api("/api/reminders?view=" + encodeURIComponent(view) + "&limit=100");
  const target = clear($("#reminder-list"));
  $("#reminder-due-count").textContent = String(response.due) + " vencido(s)";
  updateReminderBadge(response.due);
  $("#reminder-status").textContent = "Avisos somente no painel · " +
    response.reminders.length + " lembrete(s) nesta seleção.";
  await loadRecurringSchedules();
  if (!response.reminders.length) {
    target.append(info("Nenhum lembrete nesta seleção."));
    return;
  }
  for (const reminder of response.reminders) {
    const item = node("article","reminder-item" + (reminder.status === "DUE" ? " reminder-due" : ""));
    const header = node("div","row-head");
    header.append(node("strong","",reminder.title),statusPill(reminder.status));
    item.append(header,node("p","row-meta","Agendado para " + dateTime(reminder.dueAt)));
    if (reminder.triggeredAt) item.append(node("p","hint","Venceu em " + dateTime(reminder.triggeredAt)));
    if (reminder.completedAt) item.append(node("p","hint","Concluído em " + dateTime(reminder.completedAt)));
    const buttons = node("div","actions");
    if (reminder.status === "PENDING" || reminder.status === "DUE") {
      buttons.append(makeButton("✓ Concluir","btn-outline small",async () => {
        if (!window.confirm("Marcar este lembrete como concluído?")) return;
        await api("/api/reminders/" + encodeURIComponent(reminder.id) + "/complete",{
          method:"POST",body:{confirmed:true}
        });
        await loadReminders();
        showNotice("Lembrete concluído.","success");
      }));
      buttons.append(makeButton("Cancelar","btn-ghost small",async () => {
        if (!window.confirm("Cancelar este lembrete?")) return;
        await api("/api/reminders/" + encodeURIComponent(reminder.id) + "/cancel",{
          method:"POST",body:{confirmed:true}
        });
        await loadReminders();
        showNotice("Lembrete cancelado.","success");
      }));
    }
    item.append(buttons);
    target.append(item);
  }
}
$("#reminder-form").addEventListener("submit",event => {
  event.preventDefault();
  void action(async () => {
    const localValue = $("#reminder-due").value;
    const millis = new Date(localValue).getTime();
    if (!localValue || !Number.isFinite(millis)) throw new Error("Informe data e hora válidas.");
    await api("/api/reminders",{method:"POST",body:{
      title:$("#reminder-title").value.trim(),dueAt:new Date(millis).toISOString()
    }});
    $("#reminder-title").value = "";
    $("#reminder-due").value = "";
    await loadReminders();
    showNotice("Lembrete agendado e salvo no PostgreSQL.","success");
  },$("#reminder-form button[type=submit]"));
});
$("#refresh-reminders").addEventListener("click",event => action(loadReminders,event.currentTarget));
$("#reminder-view").addEventListener("change",() => void action(loadReminders));

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
  if(result?.conflictReport){
    const report=result.conflictReport;
    target.append(node("span","status completed","Conflitos · somente leitura"));
    target.append(headline("Sobreposições da agenda · São Paulo"));
    textDetail(target,"Período",{
      today:"Hoje",tomorrow:"Amanhã",week:"Próximos 7 dias"
    }[report.period]||"—");
    textDetail(target,"Fonte",report.google==="connected"
      ?"CORTEX e Google":"CORTEX · Google não consultado");
    textDetail(target,"Conflitos",String(report.conflicts.length)+
      (report.truncated?" · amostra parcial":""));
    for(const warning of report.warnings??[])target.append(info(warning));
    if(!report.conflicts.length)target.append(info(
      "Sem sobreposições detectadas nos intervalos conhecidos desta amostra."));
    for(const item of report.conflicts){
      const entry=node("div","workflow-step");
      entry.append(node("strong","",item.first.title+" × "+item.second.title),
        node("p","row-meta",dateTime(item.at)+" · "+
          (item.severity==="confirmed"?"Sobreposição de eventos":"Possível conflito pontual")),
        node("p","hint",item.explanation));
      if(report.google==="connected"&&!report.truncated&&item.key){
        for(const subject of [item.first,item.second]){
          entry.append(makeButton("Preparar plano: "+subject.title,
            "btn-outline small",()=>prepareAgendaProposal(
              report.period,item.key,subject.id)));
        }
      }
      target.append(entry);
    }
    if(report.suggestions.length){
      target.append(headline("Sugestões tentativas · 30 minutos"));
      for(const slot of report.suggestions)
        target.append(node("p","row-meta",dateTime(slot.start)+" a "+
          dateTime(slot.end)+" · confirme antes de reagendar"));
    }
    target.append(node("p","hint","Nenhum compromisso foi alterado."));
    return;
  }
  if(result?.conflictHelp){
    target.append(headline("Conflitos · selecione um período"));
    target.append(info(result.text||"Use hoje, amanhã ou próximos 7 dias."));
    return;
  }
  if(result?.unifiedAgenda){
    const agenda=result.unifiedAgenda;
    target.append(node("span","status completed","Agenda unificada · somente leitura"));
    target.append(headline("Compromissos · São Paulo"));
    textDetail(target,"Período",{
      today:"Hoje",tomorrow:"Amanhã",week:"Próximos 7 dias"
    }[agenda.period]||"—");
    textDetail(target,"Origem",agenda.google==="connected"
      ?"CORTEX + Google Agenda":"Somente CORTEX · Google não consultado");
    textDetail(target,"Contagem",agenda.totals.cortex+" entrada(s) locais, "+
      agenda.totals.google+" evento(s) Google, "+
      agenda.totals.matched+" correspondência(s) exata(s)");
    for(const note of agenda.warnings??[])target.append(info(note));
    if(!agenda.items.length)target.append(info("Nenhum compromisso nas fontes consultadas."));
    for(const item of agenda.items){
      const entry=node("div","workflow-step");
      const when=item.allDay
        ?item.start.split("-").reverse().join("/")+" · Dia inteiro"
        :dateTime(item.start)+" · São Paulo";
      const sources=item.sources.includes("google")&&item.sources.includes("cortex")
        ?"CORTEX + Google":item.sources.includes("google")?"Google Agenda":
          item.cortexKind==="recurrence-preview"?"CORTEX · previsão recorrente":"CORTEX · salvo";
      entry.append(node("strong","",item.title),node("p","row-meta",when+" · "+sources));
      target.append(entry);
    }
    if(agenda.truncated)target.append(info(
      "Consulta parcial: os limites das fontes ou do painel podem omitir outros eventos."));
    target.append(makeButton("Ver lembretes do CORTEX ↗","btn-outline",()=>tab("reminders")));
    target.append(makeButton("Ver Google Agenda ↗","btn-outline",()=>tab("google-calendar")));
    return;
  }
  if(result?.unifiedAgendaHelp){
    target.append(headline("Agenda unificada · consulte por período"));
    target.append(info(result.text||"Use hoje, amanhã ou os próximos 7 dias."));
    return;
  }
  if(result?.googleAgenda){
    const agenda=result.googleAgenda;
    target.append(node("span","status completed","Google Agenda · somente leitura"));
    target.append(headline("Eventos do calendário principal · São Paulo"));
    textDetail(target,"Período",{
      today:"Hoje",tomorrow:"Amanhã",week:"Próximos 7 dias"
    }[agenda.period]||"—");
    textDetail(target,"Origem","Google Agenda (externo) · não são lembretes internos do CORTEX");
    if(!agenda.events.length)target.append(info("O Google não retornou eventos neste período."));
    for(const event of agenda.events){
      const entry=node("div","workflow-step");
      const when=event.allDay
        ?event.start.split("-").reverse().join("/")+" · Dia inteiro"
        :dateTime(event.start)+" · São Paulo";
      entry.append(node("strong","",event.title),
        node("p","row-meta",when+" · Google Agenda"));
      target.append(entry);
    }
    if(agenda.truncated)target.append(info(
      "Lista parcial: o Google informou que há mais eventos além dos resultados carregados."));
    target.append(makeButton("Consultar Google Agenda ↗","btn-outline",
      ()=>tab("google-calendar")));
    return;
  }
  if(result?.googleCalendarHelp){
    target.append(headline("Google Agenda · configuração necessária"));
    target.append(info(result.text||"Verifique a conexão do Google Agenda."));
    target.append(makeButton("Abrir Google Agenda ↗","btn-outline",
      ()=>tab("google-calendar")));
    return;
  }
  if(result?.agenda){
    const agenda=result.agenda;
    target.append(node("span","status completed","Consulta somente leitura"));
    target.append(headline("Agenda pessoal · São Paulo"));
    textDetail(target,"Período",{
      today:"Hoje",tomorrow:"Amanhã",week:"Próximos 7 dias"
    }[agenda.period]||"—");
    textDetail(target,"Consulta",
      agenda.counts.saved+" lembrete(s) registrado(s) e "+
      agenda.counts.projected+" ocorrência(s) prevista(s) nesta amostra");
    if(!agenda.items.length)target.append(info("Nenhum lembrete encontrado para este período."));
    for(const item of agenda.items){
      const row=node("div","workflow-step");
      row.append(node("strong","",item.title),
        node("p","row-meta",dateTime(item.dueAt)+" · "+
          (item.source==="recurrence-preview"?"Recorrência prevista (não criada)":
            item.status==="DUE"?"Lembrete vencido":"Lembrete agendado")));
      target.append(row);
    }
    if(agenda.truncated)target.append(info("A consulta foi limitada a 30 itens. Outros compromissos podem existir."));
    target.append(makeButton("Ver meus lembretes ↗","btn-outline",()=>{
      tab("reminders");
    }));
    target.append(makeButton("↓ Exportar período .ics","btn-outline",
      ()=>downloadAgendaIcs(agenda.period)));
    return;
  }
  if(result?.recurringProposal){
    const schedule=result.recurringProposal;
    target.append(headline("Prévia de lembrete recorrente"));
    textDetail(target,"Assunto",schedule.title);
    textDetail(target,"Frequência",schedule.frequency==="DAILY"?"Diariamente":
      "Semanalmente, "+(weekdayLabels[schedule.weekday]??"—"));
    textDetail(target,"Horário",schedule.time+" · São Paulo (SP)");
    textDetail(target,"Primeira ocorrência",dateTime(schedule.nextDueAt));
    target.append(node("p","hint","Ainda não foi salvo. É necessária uma confirmação."));
    target.append(makeButton("✓ Confirmar recorrência","btn-primary",async()=>{
      if(state.lastChat!==result){
        showNotice("Esta prévia não é mais a mensagem selecionada. Envie o comando novamente.");
        return;
      }
      const created=await api("/api/reminder-schedules",{method:"POST",body:{
        title:schedule.title,frequency:schedule.frequency,time:schedule.time,
        ...(schedule.frequency==="WEEKLY"?{weekday:schedule.weekday}:{})
      }});
      state.lastChat=null;
      target.append(node("p","hint","Recorrência salva: "+created.schedule.id));
      target.querySelectorAll("button").forEach(button=>{button.disabled=true;});
      showNotice("Recorrência confirmada e salva no PostgreSQL.","success");
      try{await loadRecurringSchedules();}catch{/* successful write, optional UI refresh */}
    }));
    return;
  }
  if(result?.recurringGuidance){
    target.append(info("Não foi possível interpretar a recorrência. Nada foi agendado."));
    return;
  }
  if (result?.reminderProposal) {
    const reminder = result.reminderProposal;
    const meta = node("div","detail-meta");
    meta.append(node("span","status pending","Aguardando sua confirmação"));
    target.append(meta,headline("Prévia do lembrete"));
    textDetail(target,"Assunto",reminder.title);
    textDetail(target,"Quando",dateTime(reminder.dueAt)+" · São Paulo (SP)");
    target.append(node("p","hint","Somente um aviso no painel. Nenhum lembrete foi criado ainda."));
    target.append(makeButton("✓ Confirmar e agendar","btn-primary",async () => {
      if (state.lastChat !== result) {
        showNotice("Esta prévia não é mais a mensagem selecionada. Envie o comando novamente.");
        return;
      }
      const created = await api("/api/reminders",{method:"POST",body:{
        title:reminder.title,dueAt:reminder.dueAt
      }});
      state.lastChat = null; // prevents accidental repeated confirmation
      target.append(node("p","hint","Lembrete criado e armazenado: "+created.reminder.id));
      target.querySelectorAll("button").forEach(button => {button.disabled = true;});
      showNotice("Lembrete confirmado e salvo no PostgreSQL.","success");
      try { await loadReminders(); } catch { /* The creation succeeded even if refresh fails. */ }
    }));
    return;
  }
  if (result?.reminderGuidance) {
    target.append(info("Comando de lembrete não compreendido. Nada foi agendado."));
    return;
  }
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

$("#chat-agenda-today").addEventListener("click",()=>{
  tab("chat");
  if(chatSending){
    showNotice("Aguarde a resposta atual do NEURON.");
    return;
  }
  const input=$("#message");
  if(input.value.trim()){
    showNotice("Há um rascunho não enviado. Envie ou apague antes de consultar a agenda.");
    input.focus();
    return;
  }
  input.value="Quais são meus lembretes de hoje?";
  void sendChatMessage();
});

// V19 quick Google query: explicit click and never overwrite a chat draft.
$("#chat-google-tomorrow").addEventListener("click",()=>{
  tab("chat");
  if(chatSending){
    showNotice("Aguarde a consulta atual antes de solicitar outra.");
    return;
  }
  const input=$("#message");
  if(input.value.trim()){
    showNotice("Há um rascunho não enviado. Envie ou apague antes de consultar o Google.");
    input.focus();
    return;
  }
  input.value="Quais reuniões tenho amanhã?";
  void sendChatMessage();
});

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
const workflowEventLabels = {
  WORKFLOW_CREATED: "Workflow criado",
  STEP_STATUS_CHANGED: "Etapa mudou de estado",
  RECOVERY_AUTHORIZED: "Recuperação autorizada (sem execução)"
};

function renderWorkflowTimelineEvents(target, events) {
  if (!events.length) {
    target.append(info("Não há eventos históricos registrados para este workflow."));
    return;
  }
  events.forEach(event => {
    const row = node("div", "timeline-event");
    const label = workflowEventLabels[event.kind] || "Evento do workflow";
    const heading = node("div", "timeline-event-head");
    heading.append(node("strong", "", "#" + event.seq + " · " + label));
    heading.append(node("span", "row-meta", dateTime(event.at)));
    row.append(heading);
    if (event.stepId) row.append(node("p", "", "Etapa: " + event.stepId
      + (event.tool ? " · " + event.tool : "")));
    if (event.from && event.to) {
      row.append(node("p", "row-meta",
        (statusLabels[event.from] || event.from) + " → " + (statusLabels[event.to] || event.to)));
    }
    row.append(node("p", "row-meta", "Origem: " + ({
      engine: "Motor do CORTEX", routing: "Decisão de fluxo", operator: "Confirmação humana"
    }[event.source] || "Registro interno")));
    target.append(row);
  });
}

function renderWorkflowDiagnostic(target, timeline) {
  clear(target);
  const diagnostic = timeline.diagnostic;
  target.append(node("p", "diagnostic-label", "Diagnóstico atual · " + timeline.status));
  target.append(node("p", "", diagnostic.message));
  target.append(node("p", "hint", "Próxima ação: " + diagnostic.nextAction));
  if (!timeline.historyComplete) {
    target.append(node("p", "hint",
      "Histórico parcial: este workflow foi criado antes do registro de eventos ou ultrapassou o limite de retenção."));
  }
  target.append(headline("Eventos registrados (mais recentes primeiro)"));
  renderWorkflowTimelineEvents(target, timeline.events || []);
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

  target.append(headline("Linha do tempo · últimos eventos"));
  const recentEvents = (workflow.events || []).slice(-8).reverse();
  renderWorkflowTimelineEvents(target, recentEvents);
  if (!workflow.events?.length || workflow.events[0]?.kind !== "WORKFLOW_CREATED") {
    target.append(node("p", "hint",
      "Histórico parcial ou indisponível para versões antigas; não são reconstruídos eventos inexistentes."));
  }
  const diagnostics = node("div", "workflow-diagnostics");
  target.append(makeButton("◷ Consultar diagnóstico detalhado", "btn-outline", async () => {
    const timeline = await api(
      "/api/workflows/" + encodeURIComponent(workflow.id) + "/timeline?limit=100"
    );
    renderWorkflowDiagnostic(diagnostics, timeline);
    showNotice("Diagnóstico consultado em modo somente leitura.", "success");
  }));
  target.append(diagnostics);
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
import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { readFile } from "node:fs/promises";
import { Script, runInNewContext } from "node:vm";
import { resolve } from "node:path";
import { parseVideoRange, registerConsole } from "../src/console.js";

describe("CORTEX web console", () => {
  it("serves the dashboard and its same-origin assets", async () => {
    const app = Fastify();
    registerConsole(app);

    const root = await app.inject({ method: "GET", url: "/" });
    expect(root.statusCode).toBe(302);
    expect(root.headers.location).toBe("/console");

    const index = await app.inject({ method: "GET", url: "/console" });
    expect(index.statusCode).toBe(200);
    expect(index.headers["content-type"]).toContain("text/html");
    expect(index.body).toContain("CORTEX");
    expect(index.body).toContain('src="/console/app.js"');
    expect(index.body).toContain('id="cortex-splash"');
    expect(index.body).toContain('id="cortex-splash-video"');
    expect(index.body).toContain('id="cortex-splash-skip"');
    expect(index.body).toContain('src="/console/media/logo.png"');
    expect(index.body).toContain('src="/console/media/intro.mp4"');
    expect(index.body).toContain('id="workflow-objective"');
    expect(index.body).toContain('value="conditional"');
    expect(index.body).toContain('value="recovery"');
    expect(index.body).toContain('id="propose-workflow"');
    expect(index.body).toContain('id="chat-workflow-status"');
    expect(index.body).toContain('data-tab="monitoring"');
    expect(index.body).toContain('data-tab="alerts"');
    expect(index.body).toContain('id="nav-alert-count"');
    expect(index.body).toContain('id="alerts-list"');
    expect(index.body).toContain('id="alerts-view"');
    expect(index.body).toContain('id="alerts-limit"');
    expect(index.body).toContain('id="alerts-watch-toggle"');
    expect(index.body).toContain('id="alerts-browser-toggle"');
    expect(index.body).toContain('id="alerts-watch-status"');
    expect(index.body).toContain('id="refresh-alerts"');
    expect(index.body).toContain('id="monitor-scope"');
    expect(index.body).toContain('id="monitor-limit"');
    expect(index.body).toContain('id="monitor-status-distribution"');
    expect(index.body).toContain('id="monitor-alerts"');
    expect(index.body).toContain('id="monitor-activity"');
    expect(index.body).toContain('id="monitor-recent"');
    expect(index.body).toContain('data-panel="reminders"');
    expect(index.body).toContain('id="reminder-form"');
    expect(index.body).toContain('id="recurrence-form"');
    expect(index.body).toContain('id="recurrence-weekday"');
    expect(index.body).toContain('href="/console/styles.css"');
    expect(index.body).not.toContain("127.0.0.1:3000/api/chat");

    const script = await app.inject({ method: "GET", url: "/console/app.js" });
    expect(script.statusCode).toBe(200);
    expect(script.headers["content-type"]).toContain("javascript");
    expect(script.body).toContain('api("/api/chat"');
    expect(script.body).toContain('function startCortexSplash()');
    expect(script.body).toContain('video.addEventListener("ended", finish');
    expect(script.body).toContain('playing.catch(showFallback)');
    expect(script.body).toContain('api("/api/reminders"');
    expect(script.body).toContain('function loadReminders()');
    expect(script.body).toContain('async function loadRecurringSchedules()');
    expect(script.body).toContain('api("/api/reminder-schedules"');
    expect(script.body).toContain('if(result?.recurringProposal)');
    expect(script.body).toContain('if(result?.agenda)');
    expect(index.body).toContain('id="chat-agenda-today"');
    expect(script.body).toContain('if (result?.reminderProposal)');
    expect(script.body).toContain('Confirmar e agendar');
    expect(script.body).toContain('api("/api/workflows/propose"');
    expect(script.body).toContain("{{steps.primeiro.result}}/3");
    expect(script.body).toContain("{{steps.a.result}}+{{steps.b.result}}");
    expect(script.body).toContain('dependsMode: "settled"');
    expect(script.body).toContain('SKIPPED: "Ignorada"');
    expect(script.body).toContain('RECOVERY_REQUIRED: "Recuperação exige confirmação"');
    expect(script.body).toContain('onFailureOf: "original"');
    expect(script.body).toContain('"/recovery"');
    expect(script.body).toContain('confirmed: true, note');
    expect(script.body).toContain('workflow.recoveries?.length');
    expect(script.body).toContain('function renderWorkflowTimelineEvents(target, events)');
    expect(script.body).toContain('function renderWorkflowDiagnostic(target, timeline)');
    expect(script.body).toContain('"/timeline?limit=100"');
    expect(script.body).toContain('Histórico parcial');
    expect(script.body).toContain('Consultar diagnóstico detalhado');
    expect(script.body).toContain("Não executada: ");
    expect(script.body).toContain("Entrada resolvida utilizada:");
    expect(script.body).toContain('function askWorkflowStatus(id)');
    expect(script.body).toContain('api("/api/monitoring/overview?limit="');
    expect(script.body).toContain('"/api/alerts?limit="');
    expect(script.body).toContain('api("/api/alerts/acknowledge"');
    expect(script.body).toContain("function renderAlerts(snapshot)");
    expect(script.body).toContain("function selectNewOperationalAlerts(snapshot, known, hasBaseline)");
    expect(script.body).toContain("function notifyNewOperationalAlerts(alerts)");
    expect(script.body).toContain("60000");
    expect(script.body).toContain("Notification.requestPermission()");
    expect(script.body).toContain("alertWatchTimer === null");
    expect(script.body).toContain("alertMessageForManualShare(alert)");
    expect(script.body).toContain('confirmed: true');
    expect(script.body).toContain('Copiar aviso (não envia)');
    expect(script.body).toContain("function renderMonitoring(snapshot)");
    expect(script.body).toContain("monitorStatuses.forEach(status =>");
    expect(script.body).toContain("monitorStepStatuses.forEach(status =>");
    expect(script.body).toContain("openMonitoredWorkflow(alert.workflowId)");
    expect(script.body).toContain("function monitorDuration(ms)");
    expect(script.body).toContain("result?.workflowReport");

    const stylesheet = await app.inject({ method: "GET", url: "/console/styles.css" });
    expect(stylesheet.statusCode).toBe(200);
    expect(stylesheet.headers["content-type"]).toContain("text/css");
    expect(stylesheet.body).toContain(".monitor-bar-track");
    expect(stylesheet.body).toContain(".cortex-splash-video");
    expect(stylesheet.body).toContain(".splash-skip");
    expect(stylesheet.body).toContain(".operational-alert.critical");
    expect(stylesheet.body).toContain(".nav-alert-count[hidden]");
    expect(stylesheet.body).toContain(".monitor-alert.critical");
    expect(stylesheet.body).toContain(".monitor-recent-grid");

    for (const response of [index, script, stylesheet]) {
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["content-security-policy"]).toContain("connect-src 'self'");
      expect(response.headers["content-security-policy"]).toContain("media-src 'self'");
      expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    }

    await app.close();
  });

  function setupChatHandlers(
    source: string,
    overrides: { api?: (path: string, options: unknown) => Promise<unknown> } = {}
  ) {
    const start = source.indexOf("let chatSending = false;");
    const finish = source.indexOf("function renderChatInspection(result)", start);
    expect(start).toBeGreaterThan(-1);
    expect(finish).toBeGreaterThan(start);

    type KeyEvent = {
      key: string; shiftKey: boolean; ctrlKey: boolean; altKey: boolean;
      metaKey: boolean; isComposing: boolean; keyCode: number;
      preventDefault: () => void;
    };
    const input = { value: "Calcule 25*18" };
    const button = { disabled: false };
    const checkbox = { checked: false };
    const key = vi.fn();
    const submit = vi.fn();
    const form = {
      addEventListener: (_name: string, callback: (event: { preventDefault: () => void }) => void) => {
        submit.mockImplementation(callback);
      }
    };
    const textarea = {
      ...input,
      addEventListener: (_name: string, callback: (event: KeyEvent) => void) => {
        key.mockImplementation(callback);
      }
    };
    const api = vi.fn(overrides.api ?? (async () => ({
      requestId: "req-1", text: "O resultado é 450.",
      plan: { objective: input.value, status: "COMPLETED", steps: [] }
    })));
    const messages = vi.fn();
    const notice = vi.fn();
    const inspect = vi.fn();
    const state = { busy: true, lastChat: null as unknown }; // background refresh must not block chat
    runInNewContext(source.slice(start, finish), {
      $: (selector: string) => {
        if (selector === "#message") return textarea;
        if (selector === "#dry-run") return checkbox;
        if (selector === "#chat-form button[type=submit]") return button;
        if (selector === "#chat-form") return form;
        throw new Error("Unexpected selector: " + selector);
      },
      api, addMessage: messages, renderChatInspection: inspect,
      showNotice: notice, hideNotice: vi.fn(), loadTasks: vi.fn(), state,
      // The mocked API rejects with a host-realm Error. Match the browser's
      // single-realm behavior so "instanceof Error" preserves its message.
      Error
    });
    const keydown = (changes: Partial<KeyEvent> = {}) => {
      const preventDefault = vi.fn();
      key({
        key: "Enter", shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
        isComposing: false, keyCode: 13, preventDefault, ...changes
      });
      return preventDefault;
    };
    return { textarea, input, button, api, messages, notice, inspect, state, keydown, submit };
  }

  it("actually sends through the API on Enter and through the button submit handler", async () => {
    const source = await readFile(resolve(process.cwd(), "web/app.js"), "utf8");
    const chat = setupChatHandlers(source);

    expect(chat.keydown()).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(chat.messages).toHaveBeenCalledTimes(2));
    expect(chat.api).toHaveBeenCalledWith("/api/chat", {
      method: "POST", body: { message: "Calcule 25*18", dryRun: false }
    });
    expect(chat.notice).toHaveBeenCalledWith(
      "Mensagem enviada ao servidor. Aguardando resposta do NEURON..."
    );
    expect(chat.messages).toHaveBeenNthCalledWith(1, "VOCÊ", "Calcule 25*18", true);
    expect(chat.messages).toHaveBeenNthCalledWith(2, "NEURON", "O resultado é 450.");
    expect(chat.button.disabled).toBe(false);
    expect(chat.textarea.value).toBe("");
    expect(chat.state.lastChat).toMatchObject({ requestId: "req-1" });

    chat.textarea.value = "Outro teste";
    const preventDefault = vi.fn();
    chat.submit({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(chat.api).toHaveBeenCalledTimes(2));
    expect(chat.api).toHaveBeenNthCalledWith(2, "/api/chat", {
      method: "POST", body: { message: "Outro teste", dryRun: false }
    });
  });

  it("keeps Shift+Enter for newlines and preserves draft on API failures", async () => {
    const source = await readFile(resolve(process.cwd(), "web/app.js"), "utf8");
    const failingApi = vi.fn(async () => { throw new Error("Network unreachable"); });
    const chat = setupChatHandlers(source, { api: failingApi });
    for (const changes of [
      { shiftKey: true }, { isComposing: true }, { keyCode: 229 },
      { key: "A" }, { ctrlKey: true }, { altKey: true }, { metaKey: true }
    ]) {
      expect(chat.keydown(changes)).not.toHaveBeenCalled();
    }
    expect(chat.api).not.toHaveBeenCalled();

    chat.keydown();
    await vi.waitFor(() => expect(chat.notice).toHaveBeenCalledWith(
      "Falha ao enviar ao NEURON: Network unreachable", "error"
    ));
    expect(chat.textarea.value).toBe("Calcule 25*18");
    expect(chat.messages).not.toHaveBeenCalled();
    expect(chat.button.disabled).toBe(false);
  });

  it("requests workflow summaries only on click and preserves unfinished chat drafts", async () => {
    const source = await readFile(resolve(process.cwd(), "web/app.js"), "utf8");
    const start = source.indexOf("function askWorkflowStatus(id) {");
    const end = source.indexOf("// Workflows", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const input = { value: "", focus: vi.fn() };
    const tab = vi.fn();
    const sendChatMessage = vi.fn();
    const showNotice = vi.fn();
    let clickHandler: (() => void) | undefined;
    const button = {
      addEventListener: (_type: string, callback: () => void) => { clickHandler = callback; }
    };
    runInNewContext(source.slice(start, end), {
      $: (selector: string) => selector === "#message" ? input : button,
      tab, sendChatMessage, showNotice,
      chatSending: false
    });
    expect(clickHandler).toBeDefined();
    expect(sendChatMessage).not.toHaveBeenCalled();

    clickHandler?.();
    expect(tab).toHaveBeenCalledWith("chat");
    expect(input.value).toBe("Como estão meus workflows?");
    expect(sendChatMessage).toHaveBeenCalledOnce();

    // A second consultation cannot erase text the user has not sent.
    input.value = "Meu rascunho de mensagem";
    clickHandler?.();
    expect(input.value).toBe("Meu rascunho de mensagem");
    expect(input.focus).toHaveBeenCalledOnce();
    expect(sendChatMessage).toHaveBeenCalledOnce();
    expect(showNotice).toHaveBeenCalledWith(expect.stringContaining("rascunho"));
  });

  it("prepares a privacy-safe manual alert without including user objectives or secrets", async () => {
    const source = await readFile(resolve(process.cwd(), "web/app.js"), "utf8");
    const start = source.indexOf("function alertMessageForManualShare(alert) {");
    const finish = source.indexOf("function renderAlerts(snapshot) {", start);
    expect(start).toBeGreaterThan(-1);
    expect(finish).toBeGreaterThan(start);
    const preview = runInNewContext(
      source.slice(start, finish) +
      '\nalertMessageForManualShare({ workflowId: "a1", status: "FAILED",' +
      ' severity: "critical", objective: "DO_NOT_SHARE_OBJECTIVE",' +
      ' message: "Falha controlada", nextAction: "Investigar efeito externo",' +
      ' input: "DO_NOT_SHARE_INPUT", output: "DO_NOT_SHARE_OUTPUT" })',
      { statusLabels: { FAILED: "Falhou" } }
    ) as string;
    expect(preview).toContain("a1");
    expect(preview).toContain("Falhou");
    expect(preview).toContain("Investigar efeito externo");
    expect(preview).not.toContain("DO_NOT_SHARE_OBJECTIVE");
    expect(preview).not.toContain("DO_NOT_SHARE_INPUT");
    expect(preview).not.toContain("DO_NOT_SHARE_OUTPUT");
    expect(preview).toContain("preparado manualmente");
  });

  it("establishes a silent alert baseline, then deduplicates new versions", async () => {
    const source = await readFile(resolve(process.cwd(), "web/app.js"), "utf8");
    const start = source.indexOf("function operationalAlertKey(alert) {");
    const end = source.indexOf("function updateAlertWatchControls()", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    type Alert = { workflowId: string; version: number; status: string; acknowledged: boolean };
    const choose = runInNewContext(
      source.slice(start, end) + "\nselectNewOperationalAlerts;",
      {}
    ) as (snapshot: { alerts: Alert[] }, known: Set<string>, baseline: boolean) => Alert[];

    const first: Alert = {
      workflowId: "first", version: 1, status: "FAILED", acknowledged: false
    };
    const second: Alert = {
      workflowId: "second", version: 1, status: "RECOVERY_REQUIRED", acknowledged: false
    };
    const known = new Set<string>();

    expect(choose({ alerts: [first] }, known, false)).toHaveLength(0);
    expect(known.has("first:1:FAILED")).toBe(true);
    expect(choose({ alerts: [first] }, known, true)).toHaveLength(0);
    expect(choose({ alerts: [first, second] }, known, true)).toHaveLength(1);
    expect(choose({ alerts: [first, second] }, known, true)).toHaveLength(0);
    expect(choose({ alerts: [{ ...first, version: 2 }] }, known, true)).toHaveLength(1);
    expect(choose({ alerts: [{ ...second, version: 2, acknowledged: true }] },
      known, true)).toHaveLength(0);
  });

  it("does not send desktop notices without explicit opt-in and hides sensitive text", async () => {
    const source = await readFile(resolve(process.cwd(), "web/app.js"), "utf8");
    const start = source.indexOf("function notifyNewOperationalAlerts(alerts) {");
    const end = source.indexOf("async function loadAlerts()", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const notifications: Array<{ title: string; body: string }> = [];
    class NotificationMock {
      static permission = "granted";
      onclick: (() => void) | null = null;
      constructor(title: string, options: { body: string }) {
        notifications.push({ title, body: options.body });
      }
      close() {}
    }
    const browser = { Notification: NotificationMock, focus: vi.fn() };
    const sandbox = {
      window: browser, browserAlertsEnabled: false,
      alertWatchTimer: null as number | null, tab: vi.fn()
    };
    const notify = runInNewContext(
      source.slice(start, end) + "\nnotifyNewOperationalAlerts;",
      sandbox
    ) as (alerts: Array<Record<string, unknown>>) => void;
    const alert = {
      workflowId: "private-workflow", objective: "private-customer-name",
      severity: "critical", status: "FAILED"
    };

    notify([alert]);
    expect(notifications).toHaveLength(0);
    sandbox.browserAlertsEnabled = true;
    notify([alert]); // Permission alone cannot start watching.
    expect(notifications).toHaveLength(0);
    sandbox.alertWatchTimer = 1;
    NotificationMock.permission = "denied";
    notify([alert]);
    expect(notifications).toHaveLength(0);

    NotificationMock.permission = "granted";
    notify([alert]);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.body).not.toContain("private-workflow");
    expect(notifications[0]?.body).not.toContain("private-customer-name");
    expect(notifications[0]?.body).toContain("verificado");
  });

  it("ships parseable JavaScript without embedding server secrets or local URL assumptions", async () => {
    const script = await readFile(resolve(process.cwd(), "web/app.js"), "utf8");
    expect(() => new Script(script, { filename: "web/app.js" })).not.toThrow();
    expect(script).toContain('credentials: "same-origin"');
    expect(script).not.toContain("localStorage");
    expect(script).not.toContain("sessionStorage");
    expect(script).not.toContain("http://127.0.0.1:3000");
  });
});

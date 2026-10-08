import type { WorkflowStore } from "./store.js";
import { readyWorkflowSteps, workflowResponse, workflowStatus, type WorkflowRun } from "./types.js";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const UUID_IN_TEXT = /\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/i;
const IN_FLIGHT_GRACE_MS = 30_000;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 20;

export interface WorkflowReportItem {
  id: string;
  objective: string;
  status: ReturnType<typeof workflowStatus>;
  completed: number;
  skipped: number;
  total: number;
  percent: number;
  nextStepIds: string[];
  attention: string;
  updatedAt: string;
}

export interface WorkflowReport {
  mode: "single" | "recent";
  count: number;
  limit: number;
  workflows: WorkflowReportItem[];
  text: string;
  readOnly: true;
}

function reportItem(run: WorkflowRun, now: number): WorkflowReportItem {
  const snapshot = workflowResponse(run);
  const status = snapshot.status;
  let attention = "";
  if (status === "AWAITING_APPROVAL") {
    const pending = run.steps.find(step => step.status === "WAITING_APPROVAL");
    attention = pending
      ? `A etapa "${pending.id}" aguarda aprovação explícita. Após aprovar, avance manualmente.`
      : "Uma etapa aguarda aprovação explícita.";
  } else if (status === "NEEDS_RECONCILIATION") {
    const running = run.steps.find(step => step.status === "RUNNING");
    const age = running?.startedAt ? now - Date.parse(running.startedAt) : Number.POSITIVE_INFINITY;
    attention = Number.isFinite(age) && age >= 0 && age < IN_FLIGHT_GRACE_MS
      ? "Uma etapa está em execução; aguarde o resultado antes de qualquer reconciliação."
      : "Há uma etapa com resultado incerto. Verifique externamente antes de reconciliar; não repita automaticamente.";
  } else if (status === "FAILED") {
    attention = "O fluxo falhou; exige análise antes de qualquer novo plano.";
  } else if (status === "COMPLETED") {
    attention = snapshot.progress.skipped > 0
      ? "Fluxo finalizado: " + snapshot.progress.completed + " etapas executadas e "
        + snapshot.progress.skipped + " ignoradas pelas condições."
      : "Todas as etapas foram concluídas.";
  } else {
    const ready = readyWorkflowSteps(run);
    attention = ready.length
      ? `Próxima etapa disponível: ${ready.map(step => step.id).join(", ")}. O avanço depende de comando explícito.`
      : "Não há etapa pronta; verifique dependências.";
  }

  return {
    id: run.id,
    objective: run.objective,
    status,
    completed: snapshot.progress.completed,
    skipped: snapshot.progress.skipped,
    total: snapshot.progress.total,
    percent: snapshot.progress.percent,
    nextStepIds: snapshot.progress.ready,
    attention,
    updatedAt: run.updatedAt
  };
}

const statusText: Record<WorkflowReportItem["status"], string> = {
  ACTIVE: "ativo",
  AWAITING_APPROVAL: "aguardando aprovação",
  NEEDS_RECONCILIATION: "execução em curso ou resultado incerto",
  COMPLETED: "concluído",
  FAILED: "falhou"
};

function formatItem(item: WorkflowReportItem): string {
  return [
    `• ${item.objective} (ID: ${item.id})`,
    `  Situação: ${statusText[item.status]}; ${item.completed} executadas, ${item.skipped} ignoradas de ${item.total} etapas (${item.percent}% resolvido).`,
    `  ${item.attention}`
  ].join("\n");
}

export function matchesWorkflowStatusQuestion(message: string): boolean {
  // Explicit read-only questions only. Never interpret action requests as
  // authorization or swallow a request that should go to the normal agent.
  if (message.length > 1000) return false;
  const normalized = message.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const workflowMentioned = /\b(workflows?|fluxos?)\b/.test(normalized);
  const asksStatus = /\b(status|progresso|andamento|situacao|acompanhar|acompanhe|acompanhamento|resumo|resuma|resumir|relatorio|consultar|consulta|mostre|mostrar|liste|listar|como estao|como esta|faltam|falta|restam|resta|ativos|ativo|pendentes|pendente)\b/.test(normalized);
  const actionCommand = /\b(cria|crie|criar|execute|executa|executar|aprove|aprova|aprovar|reconciliar|reconcile|excluir|exclua|delete|remover|remova|agendar|iniciar|avance|avancar|continuar|retomar|retome|cancelar|cancele|reiniciar|reinicie|autorizar|autorize)\b/.test(normalized);
  return workflowMentioned && asksStatus && !actionCommand;
}

/**
 * Deterministic, owner-scoped reporting. The LLM never receives raw workflow
 * records or permission tokens. Reads do not call the executor or mutate state.
 */
export class WorkflowReporter {
  constructor(
    private readonly store: WorkflowStore,
    private readonly now: () => number = () => Date.now()
  ) {}

  async summarize(userId: string, options: { id?: string; limit?: number } = {}): Promise<WorkflowReport> {
    const limit = options.limit ?? DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new Error("limit must be an integer from 1 to 20");
    }
    const id = options.id;
    if (id !== undefined && !UUID.test(id)) {
      throw new Error("Invalid workflow id");
    }
    const selected = id ? await this.store.get(userId, id) : undefined;
    const runs = id
      ? selected ? [selected] : []
      : await this.store.list(userId, limit);
    const items = runs.filter((run): run is WorkflowRun => Boolean(run)).map(run => reportItem(run, this.now()));
    const mode = id ? "single" : "recent";
    let text: string;
    if (items.length === 0) {
      text = id
        ? "Não encontrei esse workflow na sua conta. Verifique o identificador."
        : "Não encontrei workflows cadastrados para sua conta. Você pode criar um na aba Workflows v2.";
    } else if (mode === "single") {
      text = `Relatório de acompanhamento do CORTEX:\n${formatItem(items[0]!)}`;
    } else {
      const active = items.filter(item => item.status === "ACTIVE").length;
      const approvals = items.filter(item => item.status === "AWAITING_APPROVAL").length;
      const uncertain = items.filter(item => item.status === "NEEDS_RECONCILIATION").length;
      const failures = items.filter(item => item.status === "FAILED").length;
      const done = items.filter(item => item.status === "COMPLETED").length;
      const countText = (n: number, singular: string, plural: string): string =>
        `${n} ${n === 1 ? singular : plural}`;
      const headline = [
        `Dos ${items.length} workflows recentes consultados:`,
        countText(active, "ativo", "ativos") + ",",
        countText(approvals, "aguardando aprovação", "aguardando aprovação") + ",",
        countText(uncertain, "com execução/resultado pendente", "com execução/resultado pendente") + ",",
        countText(failures, "com falha", "com falha") + " e",
        countText(done, "concluído", "concluídos") + "."
      ].join(" ");
      text = [headline, ...items.map(formatItem)].join("\n\n");
    }

    return {
      mode,
      count: items.length,
      limit,
      workflows: items,
      text,
      readOnly: true
    };
  }

  async handleChatMessage(userId: string, message: string): Promise<WorkflowReport | undefined> {
    if (!matchesWorkflowStatusQuestion(message)) return undefined;
    const id = message.match(UUID_IN_TEXT)?.[0];
    return this.summarize(userId, id ? { id } : {});
  }
}

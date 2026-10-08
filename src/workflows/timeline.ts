import {
  readyWorkflowSteps,
  workflowResponse,
  type WorkflowEvent,
  type WorkflowEventSource,
  type WorkflowRun,
  type WorkflowStepStatus
} from "./types.js";

const MAX_STORED_EVENTS = 256;
const MAX_RETURNED_EVENTS = 100;
const DEFAULT_LIMIT = 50;

export function workflowCreatedEvent(at: string): WorkflowEvent {
  return { seq: 1, at, kind: "WORKFLOW_CREATED", source: "engine" };
}

/**
 * Appends compact, non-payload state changes to the SAME CAS write as the
 * workflow state. Never put input, output, error text, approval IDs, operator
 * notes or credentials in the timeline. Audit events are not tamper-proof.
 */
export function appendWorkflowEvents(
  before: WorkflowRun,
  after: WorkflowRun,
  source: WorkflowEventSource,
  at: string
): void {
  const original = before.events ?? [];
  const events: WorkflowEvent[] = [];
  let seq = original.at(-1)?.seq ?? 0;

  for (const current of after.steps) {
    const previous = before.steps.find(step => step.id === current.id);
    if (!previous || previous.status === current.status) continue;
    seq++;
    events.push({
      seq,
      at,
      kind: "STEP_STATUS_CHANGED",
      source,
      stepId: current.id,
      tool: current.tool,
      from: previous.status,
      to: current.status
    });
  }

  const previouslyAuthorized = new Set((before.recoveries ?? []).map(item => item.stepId));
  for (const authorization of after.recoveries ?? []) {
    if (previouslyAuthorized.has(authorization.stepId)) continue;
    seq++;
    events.push({
      seq,
      at,
      kind: "RECOVERY_AUTHORIZED",
      source: "operator",
      stepId: authorization.stepId
    });
  }

  if (events.length) {
    after.events = [...original, ...events].slice(-MAX_STORED_EVENTS);
  }
}

export interface WorkflowDiagnostic {
  level: "info" | "attention" | "critical";
  message: string;
  nextAction: string;
}

export function diagnoseWorkflow(run: WorkflowRun): WorkflowDiagnostic {
  const status = workflowResponse(run).status;
  if (status === "NEEDS_RECONCILIATION") {
    return {
      level: "critical",
      message: "Existe uma execução cujo resultado pode ser incerto.",
      nextAction: "Verifique o efeito real no sistema externo antes de reconciliar. Não execute a etapa novamente."
    };
  }
  if (status === "RECOVERY_REQUIRED") {
    return {
      level: "attention",
      message: "Uma etapa falhou e há um caminho alternativo aguardando autorização.",
      nextAction: "Investigue a falha, confirme os possíveis efeitos externos e autorize a recuperação manualmente."
    };
  }
  if (status === "AWAITING_APPROVAL") {
    return {
      level: "attention",
      message: "Uma ferramenta está aguardando aprovação explícita.",
      nextAction: "Revise a solicitação e aprove ou recuse conscientemente. Só depois avance manualmente."
    };
  }
  if (status === "FAILED") {
    return {
      level: "critical",
      message: "O workflow falhou sem um caminho de recuperação concluído.",
      nextAction: "Analise a etapa e seu efeito externo; este workflow não será repetido automaticamente."
    };
  }
  if (status === "RECOVERING") {
    return {
      level: "attention",
      message: "O caminho de recuperação foi autorizado, mas não é executado automaticamente.",
      nextAction: "Inspecione a próxima etapa alternativa e use Avançar etapa para executá-la, se apropriado."
    };
  }
  if (status === "COMPLETED_WITH_FAILURES") {
    return {
      level: "info",
      message: "O caminho alternativo terminou; a falha original continua registrada.",
      nextAction: "Confira os resultados e o histórico antes de considerar o processo encerrado."
    };
  }
  if (status === "COMPLETED") {
    return {
      level: "info",
      message: "Todas as etapas planejadas foram resolvidas.",
      nextAction: "Confira os resultados das etapas concluídas; as ignoradas não executaram ferramentas."
    };
  }
  const ready = readyWorkflowSteps(run);
  return {
    level: "info",
    message: ready.length
      ? "Há " + ready.length + " etapa(s) disponível(is) para avanço manual."
      : "Nenhuma etapa está pronta; verifique dependências e decisões pendentes.",
    nextAction: ready.length
      ? "Revise a próxima etapa antes de clicar em Avançar etapa."
      : "Confira as dependências no painel. Não há execução automática."
  };
}

export function workflowTimeline(run: WorkflowRun, limit = DEFAULT_LIMIT) {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RETURNED_EVENTS) {
    throw new Error("limit must be an integer from 1 to 100");
  }
  const events = run.events ?? [];
  const snapshot = workflowResponse(run);
  return {
    workflowId: run.id,
    status: snapshot.status,
    version: run.version,
    progress: snapshot.progress,
    diagnostic: diagnoseWorkflow(run),
    events: events.slice(-limit).reverse(),
    historyComplete: events[0]?.kind === "WORKFLOW_CREATED" && events[0].seq === 1,
    readOnly: true as const
  };
}

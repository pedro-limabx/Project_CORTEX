import type { ReminderRepository } from "./store.js";

const ABSOLUTE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_FUTURE_MS = 2 * 366 * 24 * 60 * 60 * 1000;
const MIN_FUTURE_MS = 60_000;
export class ReminderInputError extends Error {}

export function validateNewReminder(input: unknown, now: Date = new Date()) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ReminderInputError("Informe título e data/hora");
  }
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some(key => !["title", "dueAt"].includes(key))
      || typeof body.title !== "string" || typeof body.dueAt !== "string") {
    throw new ReminderInputError("Somente title e dueAt são aceitos");
  }
  const title = body.title.trim();
  if (title.length < 1 || title.length > 160) {
    throw new ReminderInputError("O título deve ter entre 1 e 160 caracteres");
  }
  if (!ABSOLUTE_TIMESTAMP.test(body.dueAt)) {
    throw new ReminderInputError("Use data/hora ISO 8601 com fuso explícito (Z ou ±HH:MM)");
  }
  const milliseconds = Date.parse(body.dueAt);
  if (!Number.isFinite(milliseconds) || milliseconds < now.getTime() + MIN_FUTURE_MS
      || milliseconds > now.getTime() + MAX_FUTURE_MS) {
    throw new ReminderInputError("A data deve estar entre 1 minuto e 2 anos no futuro");
  }
  return { title, dueAt: new Date(milliseconds).toISOString() };
}

export class ReminderScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<number> | undefined;
  constructor(
    private readonly repository: Pick<ReminderRepository, "markDue">,
    private readonly user: string,
    private readonly now: () => Date = () => new Date(),
    private readonly onError: (error: unknown) => void = () => {}
  ) {}
  async checkDue(): Promise<number> {
    if (this.inFlight) return this.inFlight;
    const promise = this.repository.markDue(this.user, this.now().toISOString(), 100);
    this.inFlight = promise;
    try { return await promise; }
    finally { if (this.inFlight === promise) this.inFlight = undefined; }
  }
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {void this.checkDue().catch(this.onError);}, 15_000);
    this.timer.unref?.();
    void this.checkDue().catch(this.onError);
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }
}

# CORTEX V12 — Lembretes pessoais persistentes

A V12 introduz **lembretes únicos**, não recorrentes, separados das tarefas de workflow e dos alertas operacionais da V8–V11.

## Ativar

1. Configure DATABASE_URL para PostgreSQL e mantenha o processo Node.js em execução.
2. Abra `/console` → **Lembretes**.
3. Insira um título (1–160 caracteres) e escolha data/hora local de 1 minuto a 2 anos no futuro.
4. Os avisos ficam visíveis na própria aba e você pode concluir ou cancelar.

### API, autenticação e identidade

Todas as rotas respeitam o Bearer token configurado e o `CORTEX_USER_ID` definido **pelo servidor**:

- `GET /api/reminders?view=all|pending|due|done|cancelled&limit=50` — até 100 itens, além da contagem de avisos vencidos.
- `POST /api/reminders` — JSON `{"title":"Revisar planejamento","dueAt":"2026-10-09T14:30:00-03:00"}`. Aceita somente timestamp ISO-8601 com fuso explícito; salva em UTC.
- `POST /api/reminders/:id/complete` com `{"confirmed":true}` — marca como feito.
- `POST /api/reminders/:id/cancel` com `{"confirmed":true}` — cancela.

Sem PostgreSQL as rotas retornam 503 e não há falsa promessa de persistência.

### Entrega, concorrência e limites

Um worker periódico no processo Node.js consulta os lembretes vencidos a cada ~15 segundos. Ele funciona sem aba aberta, mas **apenas enquanto o processo e o banco estiverem ativos**. Também consulta ao abrir a aba, para detectar avisos atrasados após reinícios.

A operação no PostgreSQL usa `FOR UPDATE SKIP LOCKED` e atualização atômica `PENDING → DUE` por usuário. Depois que um item fica DUE, a mesma ocorrência não dispara novamente; o registro é mantido até confirmação/cancelamento. A execução não dispara ferramentas, LLMs, ligações, e-mails, WhatsApp, SMS nem notificações push. **O vencimento marcado como DUE não significa que a pessoa recebeu o aviso; significa apenas que ele está disponível na interface.** Ao voltar de uma suspensão do Codespaces, avisos vencidos aparecem em atraso.

Concluir/cancelar exige confirmação explícita e nunca altera workflows. Os títulos ficam armazenados no PostgreSQL e devem ser protegidos com os controles de acesso à instância. Para uso público, configure NODE_ENV=production e CORTEX_API_TOKEN de pelo menos 32 caracteres, TLS e persistência confiável.

Testes: `npm run typecheck && npm test && npm run build`; com DATABASE_URL de teste, a suíte `tests/reminders.postgres.test.ts` valida concorrência, reinício, transições e isolamento.

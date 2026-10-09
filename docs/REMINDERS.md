# CORTEX — Lembretes pessoais persistentes (V12–V15)

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

## V13 — Proposta de lembrete no chat

Agora `POST /api/chat` detecta comandos explícitos e simples como:

- `Lembre-me amanhã às 14h de revisar o projeto`
- `Lembre-me de beber água em 30 minutos`
- `Me lembre de ligar para alguém hoje às 17h30`
- `Lembre-me dia 25/12/2026 às 09h30 de ligar para família`

Horários de calendário são interpretados em **America/Sao_Paulo** (fuso de São Paulo); durações relativas usam o relógio do servidor. O interpretador é **determinístico e limitado** — não usa LLM para inventar datas. Instruções vagas como "amanhã de manhã" recebem mensagem de orientação, sem criar item. Valores fora da janela de 1 minuto a 2 anos são recusados.

A resposta do chat contém `mode: "reminder-preview"`, `created: false` e `reminderProposal: {title, dueAt, timeZone, requiresConfirmation: true}`. No painel, o botão **Confirmar e agendar** chama a rota autenticada `POST /api/reminders`, única operação que grava o lembrete no PostgreSQL. Esta prévia não executa ferramentas, LLMs, integrações externas ou escrita em banco. O indicador "Simular" continua sendo apenas prévia (como todos os comandos de lembretes no chat).

Sem banco PostgreSQL, solicitações de lembrete pelo chat retornam 503, em vez de sugerir que o agendamento será persistido. A confirmação permanece necessária a cada lembrete; reenvios explícitos podem criar novos itens. Integração semântica livre via LLM, linguagem recorrente e notificações externas ainda não fazem parte da V13.

## V14 — Acompanhamento de lembretes e avisos locais no navegador

O painel de **Lembretes** tem dois comandos independentes e opcionais:

- **Ativar acompanhamento** consulta lembretes vencidos a cada 30 segundos, enquanto a aba está aberta. Inicializa uma linha de base silenciosa: não notifica lembretes já vencidos antes da ativação.
- **Ativar avisos do navegador** solicita a permissão do navegador *somente após clicar*. Com ambos ativados, um novo vencimento apresenta aviso genérico do sistema operacional, sem incluir o título ou outras informações pessoais. Clique para voltar à aba de Lembretes.

A contagem de lembretes `DUE` aparece na navegação e atualiza ao abrir a aba ou durante o acompanhamento. Notificações de sistema só acontecem se: monitoramento estiver ligado, o site estiver em contexto seguro (HTTPS/localhost), a permissão for concedida e houver novo vencimento após a ativação.

Proteções: monitoramento e avisos são **desativados por padrão e não persistem entre recarregamentos**; a seleção de IDs é mantida na memória da aba para suprimir duplicações; avisos mais antigos não são disparados em massa; uma única notificação genérica representa vários vencimentos detectados no mesmo ciclo. A consulta retorna no máximo 100 registros vencidos — não é varredura histórica ilimitada.

**Limitações:** não existe Service Worker, Web Push, push móvel, background sync, SMS, e-mail ou entrega quando a aba está fechada. Em segundo plano, navegadores podem limitar a frequência dos timers. O PostgreSQL e o processo Node precisam estar ativos para a atualização dos estados; o servidor não garante entrega ao sistema operacional. O sistema não executa ferramentas ou outras ações ao disparar esses avisos.

## V15 — Recorrências diárias e semanais

- Na aba Lembretes → Recorrências, escolha assunto, frequência DAILY ou WEEKLY, hora HH:MM de São Paulo e, para WEEKLY, dia da semana (0 domingo a 6 sábado).
- POST /api/reminder-schedules aceita {"title":"Verificar agenda","frequency":"DAILY","time":"07:00"}; para semanal, use frequency WEEKLY e weekday entre 0 e 6.
- GET /api/reminder-schedules?limit=50 consulta as regras; POST /api/reminder-schedules/:id/pause, /resume e /cancel exigem {"confirmed":true}.
- O chat aceita comandos explícitos, como 'Lembre-me todos os dias às 7h de verificar meus compromissos' e 'Lembre-me toda segunda-feira às 9h de conferir a agenda'. Ele oferece uma prévia que precisa ser confirmada antes de gravar.

O worker Node.js salva cada ocorrência na tabela cortex_reminders com transações e um índice único em schedule_id/due_at. FOR UPDATE SKIP LOCKED impede réplicas de duplicarem uma execução. Após uma indisponibilidade prolongada, é criada no máximo uma ocorrência atrasada por regra, referente ao primeiro horário perdido, e o próximo horário avança para o futuro; isso evita inundar a caixa de entrada. Pausar impede futuras ocorrências; retomar salta horários passados; cancelar é irreversível e não apaga o histórico. Avisos já criados seguem disponíveis para concluir ou cancelar individualmente.

Os horários são sempre calculados no fuso America/Sao_Paulo. Regras não enviam e-mails, SMS, WhatsApp, Web Push ou executam ferramentas. O Node.js e PostgreSQL precisam estar ativos para processamento pontual; o navegador deve ficar aberto para notificações locais da V14.

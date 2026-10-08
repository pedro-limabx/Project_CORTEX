# CORTEX V10 — Monitoramento autônomo (backend)

A V10 executa um monitor **somente de leitura** dentro do processo Node.js, mesmo sem uma sessão do navegador aberta. As rotas da V8/V9, o temporizador do navegador e os fluxos existentes continuam disponíveis.

## Como ativar

1. Configure DATABASE_URL para um PostgreSQL acessível e inicie o servidor.
2. Entre em /console → Alertas → Monitor autônomo no servidor.
3. Escolha ativar, intervalo (60–3600 segundos) e cooldown (60–86400 segundos), depois salve.

A configuração é **desativada por padrão**, armazenada na tabela cortex_monitor_settings por CORTEX_USER_ID. O processo consulta se há uma verificação vencida a cada aproximadamente 15 segundos. A frequência pode sofrer atrasos por carga, interrupções ou políticas de infraestrutura; não há garantia de execução em tempo real. No primeiro uso, condições já existentes podem gerar notificações — não há pressuposto de linha de base silenciosa como na V9.

A API usa a mesma autenticação Bearer preexistente:

- GET /api/monitoring/backend — estado e preferências.
- PUT /api/monitoring/backend — JSON com enabled, intervalSeconds, cooldownSeconds.
- GET /api/notifications?view=unread&limit=50 — caixa persistente.
- POST /api/notifications/:id/read — JSON com confirmed: true.
- GET /api/monitoring/backend/events?limit=20 — trilha operacional resumida.

As notificações são inseridas em cortex_persistent_notifications com unicidade por (user_id,workflow_id,workflow_version,workflow_status). A tabela cortex_monitor_events guarda alterações de preferências, verificações bem-sucedidas e falhas, com data e contagens (sem mensagens livres). Todos os acessos usam user_id definido no servidor. Não são armazenados objetivos de workflows, conteúdos, resultados ou credenciais em notificações e eventos.

## Escopo e limites

O monitor examina no máximo os **100 workflows mais recentes** do usuário configurado, aproveitando os diagnósticos já existentes da V8. Detecta workflows nos estados FAILED, NEEDS_RECONCILIATION (respeitando a tolerância existente de 30 segundos para RUNNING recente), RECOVERY_REQUIRED, RECOVERING e AWAITING_APPROVAL. Não vasculha todas as tarefas pessoais, aprovações avulsas nem eventos de fornecedores. Não garante descoberta de workflow muito antigo fora da janela de 100.

Um bloqueio consultivo PostgreSQL por usuário evita duas instâncias processando o mesmo lote ao mesmo tempo. O banco fornece unicidade atômica por estado/versão e uma janela de redução de ruído por workflow/status. Mudanças de versão dentro do cooldown são adiadas até a janela permitir a inserção (enquanto permanecerem na amostra e no estado de atenção). Notificações históricas permanecem disponíveis após leitura; ler não significa resolver.

A arquitetura possui a interface NotificationChannel e o único adaptador InAppNotificationChannel. Futuras integrações com e-mail, Telegram, WhatsApp etc. exigem provedores, credenciais e mecanismos próprios de retry/entrega/consentimento, inexistentes nesta versão. **Não há envio externo, push com aba fechada, aprovação automática, execução automática, reconciliação nem transação**.

Sem PostgreSQL, o backend autônomo fica indisponível (HTTP 503 nas rotas que exigem persistência), enquanto as funções anteriores podem continuar em memória conforme configuração existente. O servidor Node.js precisa estar ativo, conectado ao PostgreSQL. **Codespaces suspenso/parado, servidor free-tier hibernando, queda da rede ou banco indisponível = monitor interrompido**. Para operação 24/7 real, usar hospedagem always-on e banco persistente com supervisão externa. É um monitor de processo, não um job independente de ciclo de vida da hospedagem.

Validação local: npm install && npm run typecheck && npm test && npm run build. Testes reais com banco: definir DATABASE_URL para uma base de testes PostgreSQL antes de npm test. No GitHub Actions, o job verify sobe PostgreSQL 16 e executa testes, TypeScript e build.

## CORTEX V11 — Saúde do monitor e verificação manual

- `GET /api/monitoring/backend/health`: diagnóstico autenticado do serviço (disabled, starting, healthy, degraded, overdue), atrasos e contagem de avisos não lidos, sem conteúdo de workflows.
- `POST /api/monitoring/backend/check` com corpo exato `{"confirmed":true}`: verificação manual somente de leitura, **somente com monitor ativado**. Respeita bloqueio PostgreSQL entre instâncias e intervalo mínimo de 30 segundos entre verificações, persistido entre reinícios. Não aprova, reconcilia, executa ferramentas ou invoca LLMs.
- `/console` → Alertas: diagnóstico visual e botão "Verificar agora (somente leitura)".

"Funcionando" significa somente que a última checagem registrada teve sucesso e a próxima não está atrasada em mais de 30 segundos; não é um atestado de disponibilidade 24/7. O banco e o servidor precisam continuar ativos.

Segurança: Vitest >=4.1.11 (linha 4.x) e source-map-js >=1.2.2 são exigidos; a CI roda `npm audit --audit-level=moderate` e `npm audit --omit=dev`. A migração major de Vitest é validada pelos testes da CI.

# Project CORTEX

**CORTEX** é o projeto/ecossistema que fornece a infraestrutura para a **NEURON**, a inteligência artificial central.

## Estado atual — v0.3.0

A fundação possui um ciclo agentivo inicial:

**entender → decidir usar ferramenta → executar → observar resultado → continuar/replanejar → responder**

### Implementado

- NEURON Core com loop agentivo limitado a 8 etapas.
- Tool calling estruturado compatível com APIs estilo OpenAI.
- Validação real dos inputs das ferramentas com Zod.
- Política externa de risco/permissões.
- Aprovação explícita para ações HIGH/CRITICAL.
- Dry-run.
- Timeout e tratamento de erros das ferramentas.
- Memória de sessão em processo ou persistente via PostgreSQL.
- Auditoria de chamadas de ferramentas em memória ou PostgreSQL.
- Permission Engine com armazenamento em memória ou PostgreSQL.
- Approval Engine com armazenamento em memória ou PostgreSQL.
- Autenticação opcional por token Bearer; obrigatória em produção.
- Identidade de usuário controlada pelo servidor; permissões e aprovações não são aceitas do cliente.
- Calculadora sem `eval`/`Function`.
- API HTTP para chat e catálogo de ferramentas.
- Provider local determinístico para testes.
- Provider compatível com APIs de chat no formato OpenAI.

## Próxima etapa: LLM real

O projeto mantém o `LocalTestProvider` como modo determinístico para testes e usa o provider externo quando `LOCAL_TEST_MODE=false`.

Configuração de desenvolvimento:

```env
LOCAL_TEST_MODE=false
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=sua_chave
LLM_MODEL=gpt-6-luna
```

**Nunca faça commit da API key.** O arquivo `.env` é ignorado pelo Git.

A arquitetura do CORTEX continua responsável pelo loop de ferramentas, permissões, aprovações, execução e memória; o modelo fornece a capacidade de raciocínio e seleção das ferramentas.

## Regra de segurança

O modelo pode propor uma ação, mas **não recebe autoridade por si só**. A execução passa pela política e pelo executor do CORTEX.

## Desenvolvimento

```bash
npm install
npm run typecheck
npm test
npm run build
npm run dev
```

### Modo local

```env
LOCAL_TEST_MODE=true
```

### Modo LLM externo

```env
LOCAL_TEST_MODE=false
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=
LLM_MODEL=gpt-6-luna
```


## Gerenciamento de tarefas persistidas

O NEURON registra os passos da execução (incluindo falhas e solicitações de aprovação)
e permite consultar ou retomar planos incompletos.

Rotas autenticadas (envie `Authorization: Bearer <CORTEX_API_TOKEN>` quando configurado):

| Método | Rota | Finalidade |
| --- | --- | --- |
| GET | `/api/tasks?limit=20` | Listar tarefas mais recentes (limite de 1 a 100) |
| GET | `/api/tasks/:id` | Consultar histórico e status de uma tarefa |
| POST | `/api/tasks/:id/resume` | Retomar um plano interrompido ou que aguarda aprovação |
| POST | `/api/tasks/:id/reconcile` | Resolver manualmente uma execução com resultado externo verificado |
| POST | `/api/approvals/:id/approve` | Aprovar uma ação sensível, sem executá-la |

Exemplo de retomada sem aprovação pendente:

```bash
curl -X POST http://127.0.0.1:3000/api/tasks/SEU_TASK_ID/resume \
  -H "Content-Type: application/json" \
  -d '{"message":"continue"}'
```

Ao encontrar uma ferramenta HIGH/CRITICAL, o NEURON **pausa** e retorna um
`approvalId` em `toolResults` e em `plan.steps`. O processo correto é:

1. Aprovar com `POST /api/approvals/SEU_APPROVAL_ID/approve`.
2. Retomar a tarefa original com
   `POST /api/tasks/SEU_TASK_ID/resume`, JSON
   `{"approvalId":"SEU_APPROVAL_ID"}`.
3. O executor verifica o token de aprovação para os mesmos argumentos e
   executa a ferramenta registrada, sem pedir ao LLM que refaça essa chamada.

Exemplo de reconciliação **somente depois de confirmar externamente** que o
último passo interrompido realmente terminou com sucesso:

```bash
curl -X POST http://127.0.0.1:3000/api/tasks/SEU_TASK_ID/reconcile \
  -H "Content-Type: application/json" \
  -d '{"outcome":"completed","confirmed":true}'
```

Se foi confirmado que **não executou**, use `"outcome":"failed"` e prossiga
com `/resume`. O CORTEX não tenta descobrir sozinho o resultado de uma
operação externa ambígua.

### Persistência e limites de segurança

- Configure `DATABASE_URL` para manter tarefas após reiniciar o servidor.
  No modo em memória, os dados desaparecem após o processo terminar.
- Antes de executar uma ferramenta, o CORTEX grava um estado `PLANNED`.
  Se cair durante a operação, bloqueia a retomada automática para evitar repetição
  acidental. É necessário verificar o resultado e usar `/reconcile`.
- Tarefas `COMPLETED` ou `FAILED` são terminais para o endpoint de retomada.
- O registro de passos e a aprovação de execução **não garantem transações
  exatamente uma vez** para serviços externos. Concorrência entre servidores,
  confirmações externas e idempotência dos serviços conectados ainda precisam de
  proteção adicional antes de habilitar automações financeiras ou físicas.
- `.github/workflows/ci.yml` executa typecheck, testes e build a cada push/PR,
  quando GitHub Actions estiver habilitado no repositório.

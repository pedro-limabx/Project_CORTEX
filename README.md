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


## Orquestração v2 — Workflows com dependências

O CORTEX possui agora um **motor de workflows determinístico** separado do loop
conversacional do NEURON. Cada fluxo é um grafo dirigido acíclico (DAG) de até
32 etapas, executadas **uma por chamada** de avanço, com dependências explícitas.
A versão inicial aceita definições pela API; **não transforma automaticamente**
prompts em DAGs e **não executa em segundo plano**.

### API v2

| Método | Rota | Descrição |
| --- | --- | --- |
| POST | `/api/workflows` | Cria um fluxo validado |
| GET | `/api/workflows?limit=20` | Lista os fluxos do usuário atual |
| GET | `/api/workflows/:id` | Exibe etapas, resultados e progresso |
| POST | `/api/workflows/:id/advance` | Avança no máximo uma etapa executável |
| POST | `/api/workflows/:id/reconcile` | Confirma manualmente o resultado incerto |

Como no restante da API, as rotas usam a identidade definida no servidor
(`CORTEX_USER_ID`) e exigem token Bearer quando `CORTEX_API_TOKEN` estiver definido.

Crie um fluxo com duas etapas:

```bash
curl -X POST http://127.0.0.1:3000/api/workflows \
  -H 'Content-Type: application/json' \
  -d '{
    "objective": "Calcular duas expressões em sequência",
    "steps": [
      {"id":"calculo-a","tool":"calculator.evaluate","input":{"expression":"25*18"}},
      {"id":"calculo-b","tool":"calculator.evaluate","input":{"expression":"450/3"},"dependsOn":["calculo-a"]}
    ]
  }'
```

A resposta contém `id`, `status`, `version`, `steps` e
`progress` (total, concluídas, percentual e próximas etapas prontas).

Use esse `id` para avançar uma etapa por solicitação:

```bash
curl -X POST http://127.0.0.1:3000/api/workflows/SEU_ID/advance \
  -H 'Content-Type: application/json' -d '{}'
```

Se uma ferramenta necessitar aprovação, o avanço cria uma solicitação e o
workflow passa a `AWAITING_APPROVAL`. Aprovar continua sendo uma operação
separada em `POST /api/approvals/:approvalId/approve`. Depois disso:

```bash
curl -X POST http://127.0.0.1:3000/api/workflows/SEU_ID/advance \
  -H 'Content-Type: application/json' \
  -d '{"approvalId":"ID_APROVADO"}'
```

### Garantias e limites

- O grafo rejeita IDs duplicados, ciclos e referências a dependências ausentes.
- Uma etapa só fica pronta quando todas as dependências foram concluídas.
- Os parâmetros das ferramentas são validados na criação e verificados pelo
  executor de ferramentas, permissões e aprovações.
- A transição `RUNNING` é persistida **antes** da execução.
  Se houver falha de processo durante uma ação, o fluxo assume
  `NEEDS_RECONCILIATION`, sem repetir automaticamente a etapa.
- Para reconciliar, confirme externamente o resultado, aguarde ao menos 30s
  do início do passo (o timeout do executor é 15s), e envie:

```json
{"stepId":"calculo-a","confirmed":true,"outcome":"completed"}
```

  para `POST /api/workflows/SEU_ID/reconcile`. Se foi verificado que a ação
  **não aconteceu**, envie `"outcome":"failed"`, encerrando o fluxo com falha.
- PostgreSQL mantém os workflows em uma tabela separada
  (`cortex_workflows`) com versionamento otimista para evitar que duas
  requisições concorrentes avancem o mesmo estado. No modo sem banco, os
  fluxos só existem durante a vida do processo.
- Não há execução paralela, fila, cron, idempotência transacional de efeitos
  externos ou retentativa automática. Isso é uma **fundação supervisionada**,
  não uma autorização para operações financeiras ou físicas autônomas.


## Laboratório Web — Console CORTEX

A interface experimental fica em **/console**, servida pelo próprio
servidor Fastify (porta 3000). Seus arquivos estão em
`web/index.html`, `web/styles.css` e `web/app.js`. Não é necessário
iniciar outro servidor frontend nem configurar CORS para a interface.

O console permite conversar com o NEURON, observar chamadas de ferramentas,
consultar tarefas persistidas, criar workflows por JSON, acompanhar o progresso,
avançar uma etapa de cada vez e gerenciar aprovações supervisionadas.

### Acesso online pelo GitHub Codespaces

1. Abra o Codespace e sincronize a branch `main`.
2. No terminal, dentro da raiz do repositório, inicie:

   ```bash
   HOST=0.0.0.0 npm run dev
   ```

   Para persistência, o banco indicado em `DATABASE_URL` deve estar ativo.
3. Na aba **PORTS** do Codespaces, encaminhe a porta **3000** caso necessário.
4. Mantenha a visibilidade da porta **Private** e clique em **Open in Browser**.
   O caminho da interface é `/console`, em URL semelhante a
   `https://NOME-DO-CODESPACE-3000.app.github.dev/console`.
5. Se houver `CORTEX_API_TOKEN` no servidor, informe-o no campo
   **Token Bearer** da interface. O token fica apenas na memória desta aba.

**Não confunda** `CORTEX_API_TOKEN` com `LLM_API_KEY`. A chave do modelo
continua no servidor. O workflow com calculadora funciona em
`LOCAL_TEST_MODE=true`; para chat com modelo externo, configure o provedor
e defina `LOCAL_TEST_MODE=false`.

O Codespaces fornece uma URL web de testes enquanto o processo e o Codespace
estão ativos, mas **não é uma hospedagem permanente**. A porta deve continuar
privada. Para exposição pública será necessário reforçar autenticação,
limites de uso e proteção contra abuso.


### NEURON — proposta de workflows por linguagem natural

A API agora aceita a descrição de um processo e retorna um **rascunho
validado**, sem criar tarefa, solicitar aprovação ou executar ferramenta:

```bash
curl -X POST http://127.0.0.1:3000/api/workflows/propose \
  -H 'Content-Type: application/json' \
  -d '{"objective":"Calcule 25*18 e depois 450/3"}'
```

Resposta: `definition` (JSON editável com as etapas), `source`,
`needsReview=true`, `saved=false`, `executed=false`, `warnings`
e `message`.

No **Console /console → Workflows v2**, digite o objetivo e clique em
**Gerar proposta (não executa)**. O resultado é colocado no editor JSON.
Depois de revisar os passos e os parâmetros, **Criar workflow** grava o
processo, mas ainda não executa ferramentas. Cada chamada de **Avançar
etapa** executa no máximo um passo, respeitando as aprovações de risco.

- Com `LOCAL_TEST_MODE=true`, o gerador usa exclusivamente um **modo
  demonstrativo determinístico de expressões aritméticas** e informa que
  não compreende tarefas livres; não finge ser um LLM.
- Com `LOCAL_TEST_MODE=false` e provedor configurado, o NEURON solicita
  ao modelo um grafo em JSON sem fornecer chamadas de ferramenta.
- O CORTEX verifica ferramentas existentes, schemas de entrada,
  identificadores e dependências; planos inválidos são recusados.
- A versão atual **não oferece substituição dinâmica de resultados entre
  passos**: cada entrada precisa estar definida antes da execução.
- Rascunhos gerados não substituem a revisão humana. Operações de
  alto risco continuam bloqueadas pelas políticas de permissão/aprovação.

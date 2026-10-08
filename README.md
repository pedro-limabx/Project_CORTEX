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
A versão atual aceita definições pela API e pode **propor rascunhos de DAGs**
a partir de linguagem natural. Os rascunhos exigem revisão: o sistema **não cria
nem executa automaticamente** as propostas e **não executa em segundo plano**.

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
- A versão atual permite referências explícitas a saídas de etapas já
  concluídas, desde que exista uma dependência direta. Valores são resolvidos e
  validados **antes** de qualquer solicitação de aprovação ou execução.
- Rascunhos gerados não substituem a revisão humana. Operações de
  alto risco continuam bloqueadas pelas políticas de permissão/aprovação.


### Acompanhamento de workflows pelo NEURON (somente leitura)

O CORTEX consulta workflows persistidos pelo usuário configurado no servidor
e fornece um resumo determinístico do progresso. Não executa ferramentas,
não consome aprovações e não inventa resultados de tarefas.

No **/console → NEURON Chat**, clique em **Status dos workflows**, ou escreva:

- `Como estão meus workflows?` — consulta até 10 fluxos recentes;
- `Qual o status do workflow SEU_UUID?` — consulta um fluxo específico;
- `Mostre o progresso dos fluxos` — exibe a situação e os bloqueios.

Na aba **Workflows v2**, selecione um workflow e use
**Resumir no NEURON** para consultar aquele fluxo no chat.

Também está disponível a API REST protegida pelo mesmo token Bearer:

```http
GET /api/workflows/summary
GET /api/workflows/summary?limit=20
GET /api/workflows/summary?id=UUID_DO_WORKFLOW
```

A resposta inclui `readOnly: true`, um resumo em português e os campos
`status`, `percent`, `completed`, `total`, `nextStepIds` e `attention`
para cada workflow. As contagens consideram **somente os workflows
efetivamente consultados**, com limite de 20 por chamada.

Os estados de aprovação e falha indicam próximos passos que dependem
de decisões humanas. Quando uma etapa consta como `RUNNING`, o resumo
diferencia execução recente de um resultado antigo potencialmente incerto;
nenhum desses casos dispara execução ou reconciliação automática.

**Limites:** consultas explícitas de status são reconhecidas pela camada
determinística do CORTEX, tanto no modo local quanto com LLM externo.
Solicitações de criação/execução não são reinterpretadas como consultas.
Isto não é um monitoramento contínuo em segundo plano nem um sistema
de alertas proativos; o resumo é atualizado quando o usuário consulta.


### Orquestração v3 — Resultados entre etapas

Um workflow agora pode usar o resultado produzido por uma etapa anterior
na entrada de outra ferramenta. Essa integração suporta **duas formas**:

1. **Referência tipada:** `{ "$fromStep": "primeiro", "path": "result" }`
   usa exatamente o valor JSON recebido (`number`, `string`, objeto etc.).
2. **Interpolação em texto:** `{{steps.primeiro.result}}/3`
   substitui valores escalares em strings, preservando o restante do texto.

Exemplo completo com a calculadora:

```json
{
  "objective": "Calcular 25 vezes 18 e dividir o resultado por 3",
  "steps": [
    {
      "id": "primeiro",
      "tool": "calculator.evaluate",
      "input": { "expression": "25*18" }
    },
    {
      "id": "segundo",
      "tool": "calculator.evaluate",
      "input": { "expression": "{{steps.primeiro.result}}/3" },
      "dependsOn": ["primeiro"]
    }
  ]
}
```

A primeira etapa produz `{ "result": 450 }`. Após um novo comando manual
de avanço, o CORTEX resolve a expressão da segunda etapa para `450/3`
e a calculadora retorna `{ "result": 150 }`.

Para testar sem copiar JSON, abra **/console → Workflows v2 → Modelo inicial**
e use **Encadeamento real**. Clique em **Criar workflow** e depois
em **Avançar etapa** uma vez para cada cálculo. O painel mostra
`input` (definição original), `resolvedInput` (entrada efetiva usada)
e `output` (resultado armazenado). No modo local, também é possível escrever
**"Calcule 25*18 e depois divida o resultado por 3"** no gerador de propostas.

**Regras de segurança e limites da v3:**

- Toda referência deve apontar para uma **dependência direta** declarada
  em `dependsOn`; ciclos e nomes de etapas inexistentes continuam proibidos.
- A etapa referenciada precisa estar `COMPLETED` e possuir a propriedade
  solicitada no resultado persistido. Valores ausentes não são inventados.
- Parâmetros resolvidos passam novamente pelo schema da ferramenta antes de
  executar. Tipos incompatíveis falham sem acionar a ferramenta.
- Entradas aprovadas e executadas utilizam o **mesmo JSON resolvido**.
  O valor é preservado em `resolvedInput` para auditoria operacional.
- A entrada do workflow é limitada por tamanho e profundidade; caminhos
  potencialmente perigosos, como `__proto__`, são rejeitados.
- Saídas de passos anteriores só são interpoladas em texto se forem escalares.
  Referências tipadas permitem objetos e números conforme o schema aceitar.
- **Reconciliação manual não gera valores de saída automaticamente.**
  Se uma etapa foi marcada como concluída após uma interrupção, mas não
  existe resultado persistido, dependências que precisam desse resultado
  falham de maneira segura.
- Não existe execução automática em lote, passagem de saídas entre workflows
  distintos, nem garantia transacional de efeitos externos exatamente uma vez.


### CORTEX v4 — Desvios condicionais e caminhos alternativos

Os workflows aceitam condições explícitas (`when`) que verificam resultados
**já armazenados** de etapas concluídas. O modelo pode propor essas condições,
mas não decide os caminhos durante a execução: quem compara os valores
é o motor determinístico do CORTEX.

Exemplo para experimentar em **/console → Workflows v2 → Modelo inicial →
Decisão condicional**:

```json
{
  "objective": "Desconto automático conforme valor calculado",
  "steps": [
    {
      "id": "medicao",
      "tool": "calculator.evaluate",
      "input": { "expression": "25*18" }
    },
    {
      "id": "desconto-maior",
      "tool": "calculator.evaluate",
      "input": { "expression": "{{steps.medicao.result}}*0.90" },
      "dependsOn": ["medicao"],
      "when": {
        "step": "medicao", "path": "result",
        "operator": "gte", "value": 400
      }
    },
    {
      "id": "desconto-menor",
      "tool": "calculator.evaluate",
      "input": { "expression": "{{steps.medicao.result}}*0.95" },
      "dependsOn": ["medicao"],
      "when": {
        "step": "medicao", "path": "result",
        "operator": "lt", "value": 400
      }
    },
    {
      "id": "conclusao",
      "tool": "calculator.evaluate",
      "input": { "expression": "{{steps.medicao.result}}/3" },
      "dependsOn": ["medicao", "desconto-maior", "desconto-menor"],
      "dependsMode": "settled"
    }
  ]
}
```

Depois da primeira execução, o resultado `450` satisfaz `gte 400`.
O CORTEX deixa `desconto-maior` pendente para execução supervisionada,
marca `desconto-menor` como **SKIPPED** sem executar sua ferramenta e,
após a execução do ramo escolhido, disponibiliza a etapa `conclusao`.

**Campos de decisão:**

- `when.step`: ID da etapa de origem; precisa constar em `dependsOn`;
- `when.path`: campo do resultado persistido (ex.: `result`);
- `when.operator`: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`;
- `when.value`: valor literal para a comparação;
- `dependsMode: "all"` (padrão): exige todas as dependências concluídas;
  se uma for ignorada, a etapa também será ignorada;
- `dependsMode: "settled"`: espera todas as dependências ficarem concluídas
  ou ignoradas. Requer ao menos uma dependência concluída para prosseguir;
  se todas forem ignoradas, a etapa será ignorada também.

**Segurança e persistência:**

- Condições e nomes de campos são validados no cadastro. Comparações
  numéricas exigem números; não existe coerção automática de tipos.
- Quando uma condição for falsa, o CORTEX marca a etapa como `SKIPPED`
  sem solicitar aprovação ou chamar a ferramenta.
- Resultados ausentes, inválidos ou não confirmados provocam falha
  segura: não se presume que uma condição seja verdadeira ou falsa.
- Desvios e propagações de `SKIPPED` são persistidos com controle
  otimista de versão, sem execução oculta de ferramentas.
- `progress.skipped` indica quantas etapas não foram executadas;
  `progress.completed` indica apenas as efetivamente concluídas;
  o percentual usa ambas as categorias para medir caminhos **resolvidos**.
- Uma rota sensível escolhida pela condição ainda exige aprovação
  explícita, permissões e a mesma autorização do mecanismo anterior.
- Cada pedido de avanço continua executando **no máximo uma ferramenta**;
  a resolução de etapas descartadas pode ocorrer sem executar ferramentas.

Esta entrega não adiciona paralelismo real, laços, execução automática,
retentativas externas nem subfluxos transacionais. Condições são
determinísticas e avaliadas exclusivamente sobre saídas de etapas do mesmo
workflow.


### CORTEX v5 — Recuperação supervisionada de falhas

O v5 introduz caminhos alternativos explícitos para **falhas confirmadas**.
Uma etapa normal pode falhar; uma etapa alternativa cadastrada com
`onFailureOf` fica bloqueada até o operador investigar e autorizar a
recuperação. **Nenhuma ferramenta é reexecutada ou disparada no momento
da autorização.** O operador ainda precisa avançar cada etapa separadamente.

Abra **/console → Workflows v2 → Modelo inicial → Recuperação supervisionada**
para carregar um exemplo determinístico. Ele falha ao avaliar `10/0`,
bloqueia a continuação normal, oferece a alternativa `10+5` e termina
usando a saída desse caminho alternativo.

Definição resumida:

```json
{
  "objective": "Recuperar uma etapa sem repetir efeitos externos",
  "steps": [
    { "id": "principal", "tool": "calculator.evaluate",
      "input": { "expression": "10/0" } },
    { "id": "alternativa", "tool": "calculator.evaluate",
      "input": { "expression": "10+5" },
      "dependsOn": ["principal"], "onFailureOf": "principal" }
  ]
}
```

**Fluxo supervisionado:**

1. O operador cria o workflow e clica **Avançar etapa**.
2. Se a etapa principal falhar, o workflow entra em `RECOVERY_REQUIRED`.
3. O operador investiga o que realmente ocorreu e confirma pelo console
   a recuperação, incluindo uma justificativa de 10 a 500 caracteres.
   Para integrações externas, confirme principalmente que não houve
   efeitos colaterais relevantes antes de usar o caminho alternativo.
4. O CORTEX salva a autorização e libera o handler, entrando em `RECOVERING`.
   As etapas normais bloqueadas pela falha ficam `SKIPPED`.
5. **Avançar etapa** executa no máximo uma ferramenta do caminho liberado.
   Caso seja de alto risco, a aprovação específica da ferramenta continua
   obrigatória, adicionalmente à autorização de recuperação.
6. Quando as etapas restantes terminarem, o estado passa a
   `COMPLETED_WITH_FAILURES`: a falha histórica é preservada, mas o
   caminho alternativo alcançou o final.

Endpoint autenticado, sem execução no mesmo pedido:

```http
POST /api/workflows/UUID/recovery
Content-Type: application/json

{
  "stepId": "principal",
  "confirmed": true,
  "note": "Conferi a falha e os efeitos no serviço de origem."
}
```

**Proteções:**

- `onFailureOf` exige uma etapa existente em `dependsOn`, com apenas
  **um handler por falha** e sem encadeamento de handlers de recuperação.
- A alternativa não pode ler outputs de sua etapa falha, nem usar condições
  `when` ou junções `dependsMode: "settled"`.
- A autorização depende de um passo efetivamente `FAILED`, é vinculada
  ao usuário da execução e usa CAS para evitar duplicidade em concorrência.
- Caso a etapa original termine normalmente, o handler e seus descendentes
  que dependem dele são descartados (`SKIPPED`), sem ferramentas extras.
- Falhas com `Tool timeout` são **ambíguas**, pois o serviço externo pode
  continuar a operação após o timeout. Elas permanecem como `RUNNING`
  (`NEEDS_RECONCILIATION`), sem habilitar recuperação, até o operador
  verificar externamente e reconciliar a etapa.
- Erros retornados por serviços externos também podem ter produzido efeitos
  parciais. A autorização não prova automaticamente que um efeito não ocorreu.
  Nunca habilite recuperação financeira ou física sem confirmação externa
  e mecanismos de idempotência e compensação apropriados.
- `progress.failed` preserva o total de passos falhos, enquanto
  `progress.completed` conta execuções bem-sucedidas e `progress.skipped`
  conta caminhos descartados. O percentual representa etapas
  **resolvidas**, não percentual de sucesso.
- A recuperação é supervisionada; não foram adicionadas novas retentativas
  automáticas, processos em segundo plano nem transações exatamente uma vez.

### CORTEX v6 — Linha do tempo e diagnóstico de workflows

O motor agora registra eventos de alterações de estado junto ao próprio
workflow, na **mesma gravação com controle otimista de versão (CAS)**. Isso
permite acompanhar os acontecimentos que foram persistidos sem confiar em
descrições geradas pelo LLM.

Cada registro inclui apenas o número sequencial, momento, origem, tipo de evento,
etapa/ferramenta e status anterior/novo (quando aplicável). Os eventos possíveis
são `WORKFLOW_CREATED`, `STEP_STATUS_CHANGED` e `RECOVERY_AUTHORIZED`.
**Não** são copiados parâmetros, resultados, identificadores de aprovação,
mensagens de erro, credenciais nem justificativas do operador para a trilha.
Uma transição para `RUNNING` representa a reserva persistida da etapa, e
**não** comprova que o efeito externo foi efetivamente realizado.

No **/console → Workflows v2**, escolha uma execução: a parte inferior apresenta
os últimos oito eventos, com data, etapa, estado e origem da decisão.
Clique em **Consultar diagnóstico detalhado** para acessar a leitura mais recente,
a próxima ação indicada e até 100 eventos sem iniciar qualquer ferramenta.

A API REST também expõe uma consulta autenticada por identidade do servidor:

```http
GET /api/workflows/UUID_DO_WORKFLOW/timeline
GET /api/workflows/UUID_DO_WORKFLOW/timeline?limit=100
```

A resposta retorna `workflowId`, `status`, `version`, `progress`,
`diagnostic` (`level`, `message`, `nextAction`), `events` ordenados
do mais recente para o mais antigo, `historyComplete` e `readOnly: true`.
O limite é de 1 a 100 eventos por consulta; o armazenamento mantém os
últimos **256** eventos por workflow. Eventos antigos são descartados quando
esse limite é atingido. A sequência permanece crescente.

**Histórico incompleto:** workflows criados antes desta atualização não
possuem eventos anteriores preservados. O CORTEX não fabrica esses registros.
O campo `historyComplete` retorna `false` se a criação não estiver mais no
histórico (por antiguidade ou truncamento).

**Escopo e limites de segurança:** a consulta é somente leitura, filtra por
usuário autorizado, não chama o LLM nem executa ferramentas. Os eventos são
persistidos no mesmo registro do workflow e respeitam seu controle de versão,
mas **não constituem uma trilha de auditoria imutável ou à prova de adulteração**.
Para aplicações financeiras, automação física ou integrações externas, serão
necessários logs separados, controle de acesso granular, retenção, evidências
de execução e mecanismos de idempotência.


### CORTEX v7 — Central de Monitoramento

A aba **Monitoramento** do `/console` centraliza a situação operacional dos
workflows do usuário do servidor. Os indicadores são **calculados no momento
da consulta** a partir dos workflows persistidos, e **não** executam
ferramentas, alterações de estado, aprovações ou chamadas ao LLM.

**Indicadores apresentados:**

- Total de workflows amostrados, finalizados (incluindo os recuperados),
  porcentagem finalizada **dentro da amostra** e quantos exigem atenção;
- Distribuição de workflows por estado atual, separando falhas confirmadas,
  execução de resultado incerto, aprovações e recuperação supervisionada;
- Contagem de etapas `COMPLETED`, `SKIPPED`, `FAILED`, `PENDING`,
  `RUNNING` e `WAITING_APPROVAL`;
- Tempo médio por etapa **concluída ou com falha**, apenas quando os
  timestamps de início/fim são válidos e a duração não é negativa nem
  supera sete dias. O painel indica o tamanho desta subamostra;
- Lista priorizada de workflows que exigem intervenção, com explicação
  determinística e indicação de próxima ação;
- Eventos recentes da trilha v6 e atalhos para abrir detalhes dos workflows.

**Escopo correto dos números:** a consulta retorna os **20, 50 ou 100
workflows mais recentemente atualizados** do usuário configurado no servidor.
Esse recorte **não representa um total histórico**, um sucesso mensal,
uma taxa de falhas por período ou um monitoramento contínuo. O percentual
de workflows finalizados conta os estados `COMPLETED` e
`COMPLETED_WITH_FAILURES`; portanto, não deve ser interpretado como uma
taxa de sucesso sem falhas.

A API autenticada por Bearer (quando configurado) usa a identidade do
servidor e aceita apenas limites de 1 a 100:

```http
GET /api/monitoring/overview
GET /api/monitoring/overview?limit=20
GET /api/monitoring/overview?limit=100
```

Retorna `scope`, `generatedAt`, `readOnly: true`, `statusCounts`,
`metrics`, `alerts` (até 12), `activity` (até 16) e `recent`
(até 12). `scope.isAllTime` sempre é `false`. Atividades v6 antigas
podem estar ausentes em workflows anteriores à implantação da linha do
tempo; não são inventados eventos retrospectivos.

O resultado de monitoramento **não transmite** entradas, saídas, erros
textuais detalhados, identificadores de aprovação, notas de recuperação,
credenciais nem `userId`. As consultas não alteram a versão do workflow.
A página oferece atualização manual e também atualiza seus indicadores
pelo botão global `Atualizar`. Não há sondagem recorrente em segundo plano,
alertas por e-mail ou métricas históricas agregadas nesta etapa.

**Validação:** `npm run typecheck && npm test && npm run build`.


### CORTEX v8 — Alertas operacionais e reconhecimento supervisionado

A nova aba **Alertas** em `/console` consulta a situação atual dos
workflows e organiza situações que exigem intervenção humana, em ordem
de prioridade:

- **Críticos:** `NEEDS_RECONCILIATION` (efeito externo incerto) e
  `FAILED` (falha confirmada sem recuperação concluída).
- **Atenção:** `RECOVERY_REQUIRED`, `AWAITING_APPROVAL` e
  `RECOVERING`.

Cada consulta considera **somente os últimos 20, 50 ou 100 workflows**
mais recentemente atualizados do usuário controlado pelo servidor. O
painel permite alternar entre **Não vistos** e **Todos** e mostra quantos
alertas estão ativos, quantos foram reconhecidos e quantos são críticos.
Um workflow `COMPLETED` ou `ACTIVE` não gera alerta nesta v8.

**Confirmação de leitura supervisionada:** o botão **Marcar como visto**
exige confirmação explícita e registra a identidade do usuário do
servidor, o ID do workflow, o estado exato, a versão e o horário de
reconhecimento. Isso **não** aprova ferramentas, não reconciliará
efeitos externos, não muda o estado do workflow nem resolve o problema.
Quando o workflow avança para outra versão/estado, o reconhecimento
antigo deixa de valer e o alerta volta a aparecer como não visto,
caso ainda exista um estado que exija intervenção. Confirmações
repetidas da mesma versão são idempotentes.

**Preparação de aviso:** o botão **Copiar aviso (não envia)** monta um
resumo operacional reduzido (identificador, estado, gravidade,
diagnóstico determinístico e próxima ação). Ele não inclui
o objetivo livre do usuário nem payloads, logs de erro detalhados,
credenciais, resultados ou notas privadas. O operador revisa e decide
se, onde e para quem compartilhar; o sistema **não envia** emails,
notificações push, mensagens de aplicativos nem faz checagens periódicas
em segundo plano.

A API é autenticada com o mesmo token Bearer dos outros endpoints:

```http
GET /api/alerts?limit=50&view=unread
GET /api/alerts?limit=100&view=all
```

A resposta contém `scope` (com `isAllTime: false`),
`generatedAt`, `readOnly: true`, `delivery: "manual_in_app_only"`,
`counts` e a lista de `alerts`. A contagem reflete todos os avisos
detectados na amostra, mesmo quando o filtro oculta os já vistos.

O reconhecimento exige uma versão atual e confirmação específica:

```http
POST /api/alerts/acknowledge
Content-Type: application/json

{
  "workflowId": "UUID_DO_WORKFLOW",
  "version": 3,
  "status": "RECOVERY_REQUIRED",
  "confirmed": true
}
```

Uma requisição inválida retorna `400`; workflow de outro usuário ou
inexistente retorna `404`; estado ou versão alterados retornam `409`
sem registrar o reconhecimento. A resposta bem-sucedida inclui
`acknowledgedAt`, `workflowUnchanged: true` e
`actionExecuted: false`. A confirmação não altera a versão do
workflow.

**Persistência:** com `DATABASE_URL`, o CORTEX inicializa a tabela
`cortex_alert_acknowledgements` com unicidade por
`(user_id, workflow_id, workflow_version, workflow_status)` e consultas
parametrizadas com isolamento de usuário. Sem banco, os reconhecimentos
ficam em memória e se perdem quando o processo é reiniciado; o mesmo
vale para os workflows criados sem `DATABASE_URL`. O registro confirma
apenas que o aviso foi visto, não que a investigação esteja concluída.
Não há retenção automática de reconhecimentos históricos nesta versão.

A v8 não contém provedores externos, regras de envio agendado,
supressão global de alertas nem controle de acesso por múltiplos
operadores sob a mesma identidade do servidor. Não interprete o badge
de alertas como notificação de tempo real: ele é atualizado quando
o operador acessa o painel ou utiliza os botões de atualização.

Para validar: `npm run typecheck && npm test && npm run build`.


### CORTEX v9 — Acompanhamento opcional e avisos do navegador

A v9 aproveita os avisos da v8 e acrescenta dois controles **independentes**
na aba **Alertas** de `/console`:

1. **Iniciar acompanhamento (60 s)**: atualiza a caixa de alertas e seu
   contador a cada 60 segundos **somente enquanto esta aba estiver aberta**.
   Clique em **Parar acompanhamento** para interromper imediatamente.
2. **Permitir avisos do navegador**: solicita a permissão do navegador
   exclusivamente a partir de um clique do operador. É preciso **também**
   ativar o acompanhamento para que novos incidentes produzam avisos.
   A permissão pode ser revogada nas configurações do navegador.

**Privacidade e prevenção de ruído:** a primeira leitura estabelece uma
base silenciosa, sem disparar notificações para alertas antigos. As
consultas subsequentes identificam novas combinações de ID do workflow,
versão e status. Cada uma é notificada no máximo uma vez por sessão
e no máximo três alertas são exibidos por consulta. O aviso do navegador
usa apenas texto genérico: nunca inclui objetivo do workflow, nomes de
clientes, entradas, resultados ou justificativas do operador. A caixa
interna continua contendo os detalhes autorizados.

**Execução recente:** ao montar a caixa de alertas, a v9 não classifica
automaticamente como execução incerta uma etapa em estado `RUNNING`
com horário de início válido há menos de 30 segundos. Se ela permanecer
assim por 30 segundos ou mais, passa a aparecer como incidente para
investigação. Um timeout ou outro caso com horário ausente/inválido
ainda exige verificação. O limite de 30 segundos não comprova falha
nem autoriza retentativa.

**Limitações importantes:** as verificações são temporizadores do
navegador e podem ser atrasadas por abas suspensas, políticas do sistema
e perda de conexão. Com a aba fechada, **não há monitoramento ativo,
notificações push, e-mails ou SMS**. O servidor continua respondendo
a consultas e armazenando reconhecimentos da v8, mas não faz
envios externos. As preferências de acompanhamento e a deduplicação
ficam apenas na sessão da aba; ao recarregar, é preciso ativar novamente.
Não existe integração com credenciais de e-mail ou mensageria.

O reconhecimento de um aviso permanece estritamente informativo:
não altera o workflow e não substitui investigação, autorização,
reconciliação ou execução humana.

Validação: `npm run typecheck && npm test && npm run build`.


### CORTEX V10 — Monitoramento persistente no Node.js

A V10 acrescenta o monitor autônomo (inicialmente desativado), com configuração, histórico e notificações no PostgreSQL. Funciona com o painel fechado enquanto Node.js e PostgreSQL permanecem ativos. Consulte [o guia da V10](docs/AUTONOMOUS_MONITORING.md) para API, ativação, limitações e testes. A V8/V9 continua independente e compatível.


### CORTEX — Logo e tela de abertura

O console agora suporta a logo do cérebro ao lado de **CORTEX / LABORATÓRIO OPERACIONAL** e uma splash screen com o vídeo de abertura ao carregar a página. Inclui botão para pular, suporte a reprodução silenciosa, fallback se o MP4 não estiver instalado e limite de espera contra tela bloqueada. Para instalar as mídias originais da conversa, consulte [o guia de identidade visual](docs/BRANDING.md). As mídias são arquivos separados do código e devem estar em `web/assets/` no Codespaces/deploy.

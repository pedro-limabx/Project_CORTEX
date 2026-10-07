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

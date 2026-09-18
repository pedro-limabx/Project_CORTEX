# Project CORTEX

**CORTEX** é o projeto/ecossistema que fornece a infraestrutura para a **NEURON**, a inteligência artificial central.

## Estado atual — v0.2.0

A fundação agora possui um ciclo agentivo inicial:

**entender → decidir usar ferramenta → executar → observar resultado → continuar/replanejar → responder**

### Implementado
- NEURON Core com loop agentivo limitado a 8 etapas.
- Tool calling estruturado compatível com APIs estilo OpenAI.
- Validação real dos inputs das ferramentas com Zod.
- Política externa de risco/permissões.
- Aprovação explícita para ações HIGH/CRITICAL.
- Dry-run.
- Timeout e tratamento de erros das ferramentas.
- Memória de sessão em processo.
- Calculadora sem `eval`/`Function`.
- API HTTP para chat e catálogo de ferramentas.

### Ainda não implementado
- Memória persistente PostgreSQL.
- Autenticação e identidade reais.
- Permission Engine persistente.
- Auditoria persistente.
- Browser/computer gateway.
- Voz.
- Telefonia.
- Smart Home.
- Integrações financeiras.
- Autonomia de longa duração.

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

# CORTEX / NEURON

**CORTEX** é o ecossistema de software. **NEURON** é sua inteligência central.

## v0.1 — Foundation

Esta primeira fundação implementa uma base real e modular para evolução da NEURON:
- Node.js + TypeScript;
- Fastify HTTP API;
- abstração de LLM provider compatível com APIs no formato OpenAI;
- Tool Registry e Tool Executor;
- política de permissões independente do modelo;
- memória em processo para desenvolvimento;
- PostgreSQL preparado via Docker Compose;
- health check e catálogo de ferramentas;
- testes automatizados básicos;
- documentação de arquitetura, segurança, memória, permissões, testes, limitações e roadmap;
- interface web experimental.

## O que ainda não está implementado

A v0.1 não finge possuir capacidades que ainda dependem de infraestrutura externa ou módulos futuros. Ainda faltam, entre outros:
- memória persistente de produção;
- planner multi-etapas completo;
- tool calling estruturado pelo modelo;
- autenticação de produção;
- browser/computer gateway;
- voz;
- telefonia;
- integrações bancárias reais;
- smart home;
- autonomia irrestrita.

## Execução local

Requisitos: Node.js 22+ e, opcionalmente, Docker.

1. Copie .env.example para .env.
2. Execute npm install.
3. Para PostgreSQL local, execute docker compose up -d.
4. Execute npm run dev.
5. Abra web/index.html para a interface experimental.

Configure LLM_API_KEY e LLM_MODEL no .env para usar um modelo externo compatível.

## API

- GET /health
- GET /api/tools
- POST /api/chat

Exemplo: { userId: "local-user", message: "Olá, NEURON" }

## Princípios de engenharia

1. Não inventar capacidades ou integrações.
2. Não declarar sucesso sem confirmação da execução.
3. Segurança e autorização são aplicadas fora do modelo.
4. Ações de alto risco exigem aprovação explícita.
5. Integrações externas entram por adaptadores/ferramentas.
6. Conteúdo externo é tratado como dado não confiável.
7. Testes, documentação e limitações acompanham a implementação.
8. O projeto começa como monólito modular e escala somente quando necessário.

Consulte docs/ para a arquitetura e os critérios de evolução.
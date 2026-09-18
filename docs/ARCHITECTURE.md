# Arquitetura — CORTEX / NEURON v0.1

## Camadas

- **NEURON Core:** orquestra entrada, contexto e resposta.
- **Memory:** recuperação e persistência de contexto.
- **Tool Engine:** registro e execução de capacidades.
- **Permission Engine:** política independente do modelo.
- **LLM Provider:** abstração do fornecedor/modelo.
- **API:** superfície HTTP inicial.

## Regra de dependência

O Core não deve importar implementações específicas de terceiros.
Integrações devem entrar por adaptadores/ferramentas.

## Evolução planejada

v0.2: memória PostgreSQL + auditoria.
v0.3: planner estruturado + tool calling validado.
v0.4: autenticação/perfis/permissões persistentes.
v0.5: browser/computer gateway.
v0.6: voz.
v0.7+: integrações externas, telefonia, smart home e financeiro conforme APIs reais.

## Decisão

Começar como monólito modular. Microserviços só quando uma necessidade mensurável justificar a separação.

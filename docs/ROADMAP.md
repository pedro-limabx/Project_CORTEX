# Roadmap

1. Foundation + Core — initial implementation.
2. Persistent memory + audit.
3. Structured tool calling + planner — deterministic multi-step replanning implemented; general planner remains next.
4. Authentication + persistent permissions.
5. Browser/computer gateway.
6. Voice.
7. Phone gateway using controlled VoIP/SIP first.
8. Smart-home adapters.
9. Financial adapters in sandbox/test environments first.
10. Additional integrations.

Every phase follows: analyze → implement → test → security review → document → validate.

CORTEX V12: lembretes pessoais únicos persistidos, triagem dos vencidos no backend, confirmação/cancelamento manual e painel dedicado. Integração com o chat e recorrência permanecem evoluções futuras.

V13: proposta de lembrete em linguagem natural PT-BR no NEURON Chat, com interpretação determinística, fuso São Paulo explícito e confirmação separada antes de persistir.

V14: acompanhamento de lembretes vencidos na aba e notificações locais genéricas do navegador por adesão explícita, sem push offline ou dados pessoais em notificações.

V15: agendamento persistente diário/semanal com pausa, retomada e cancelamento, ocorrências transacionais deduplicadas no PostgreSQL e prévias supervisionadas no NEURON Chat.

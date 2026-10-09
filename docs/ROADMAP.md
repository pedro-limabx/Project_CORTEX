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

V16: consulta da agenda pelo NEURON Chat e API autenticada, com janelas locais de hoje/amanhã/7 dias, leitura limitada e distinção explícita entre lembretes persistidos e recorrências previstas.

V17: exportação autenticada da agenda em iCalendar (.ics) para importação manual em outros aplicativos, com privacidade, escapes RFC 5545 e rejeição de resultados parciais.

V18: conexão opcional Google Agenda com OAuth 2.0/PKCE, permissões somente leitura, credenciais criptografadas no PostgreSQL e consulta supervisionada. Sem escrita em calendários, sincronização ou autorização automática.

V19: consultas explícitas ao Google Agenda no NEURON Chat, com distinção de origem, limites de paginação e orientação quando a integração OAuth não está ativa; preserva escopo somente leitura.

V20: visão unificada sob demanda de lembretes CORTEX e eventos Google autorizados no NEURON Chat e API, com identificação das fontes, combinação conservadora de títulos/instantes e fallback local quando o Google não está conectado.

V21: análise conservadora somente leitura dos conflitos entre eventos Google com duração e lembretes pontuais do CORTEX; avisos de dados ausentes e horários tentativos para avaliação humana, sem reagendamento automático.

V22: propostas persistentes de reorganização de agenda com escolha explícita do compromisso, geração no backend, preservação de duração, expiração e aprovação/rejeição atômicas. Aprovação não modifica compromissos externos ou internos.

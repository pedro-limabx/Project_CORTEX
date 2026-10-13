# CORTEX V26 — Central de Prioridades do NEURON

A Central de Prioridades é uma **consulta supervisionada ao estado atual** das tarefas que merecem revisão. Ela complementa a Central de Atividades V25 (histórico): a V26 apresenta **somente pendências conhecidas**, não eventos já concluídos.

## Fontes e regras

1. **Crítico:** alerta operacional **não reconhecido** de workflow classificado como crítico pelo serviço de alertas (por exemplo, falha ou necessidade de reconciliação).
2. **Alto:** lembrete internamente marcado como **DUE**, alerta operacional não reconhecido de atenção (por exemplo, aprovação ou recuperação pendente), ou proposta de agenda \`PENDING_REVIEW\` que vence em até cinco minutos.
3. **Médio:** proposta válida ainda aguardando revisão com mais de cinco minutos de validade, ou plano aprovado e ainda não executado manualmente ou via a confirmação separada da V23.

O ranking é fixo e **não usa LLM**, informações pessoais inferidas ou scoring comportamental. Cada item inclui título, justificativa, próxima etapa *sugerida*, origem, momento de referência e severidade. Ordena por criticidade; nos empates, prioriza prazos mais próximos entre decisões e, depois, a data do registro. Uma sugestão de prioridade não representa urgência médica, financeira ou legal.

A fonte de workflows é a caixa de **alertas não reconhecidos e atuais**, limitada aos **100 workflows mais recentes** do CORTEX. Não há suposição de que a ausência de alertas represente todo o histórico. Os lembretes consultados são aqueles já sinalizados como \`DUE\` pelo agendador; a Central **não modifica** o estado de lembretes pendentes para forçar vencimentos. As propostas são lidas do registro persistente do PostgreSQL e excluem decisões expiradas, rejeitadas, aplicadas ou revertidas.

Os botões **Abrir Lembretes**, **Abrir Alertas** e **Abrir Propostas de agenda** servem apenas para navegar às telas onde o usuário pode analisar e, separadamente, autorizar ações. A V26 **não reconhece alertas, conclui lembretes, aprova propostas, executa ferramentas nem altera eventos do Google**.

## API e segurança

\`GET /api/priorities?filter=all|urgent|reminders|workflows|decisions&limit=30\`

- Exige PostgreSQL e \`CORTEX_API_TOKEN\` configurado, inclusive em desenvolvimento; solicitações exigem Bearer válido.
- Proprietário da consulta definido exclusivamente por \`CORTEX_USER_ID\` no backend, nunca pelo navegador.
- \`filter\` e \`limit\` são validados (1–100). Respostas incluem \`readOnly:true\`, \`actionExecuted:false\`, \`counts\` para a **amostra** consultada, \`partial\` e \`warnings\` sobre limites.
- O serviço usa amostras de até 100 registros por fonte. Se um limite for atingido, avisa sobre cobertura possivelmente incompleta. Contagens **não são globais**.
- Resultados têm cabeçalho \`Cache-Control: private, no-store\`. A página usa \`textContent\` para todos os textos de origem, sem permitir HTML executável nem exportação automática.

## Como testar mais tarde no Codespaces

Após atualizar a \`main\`, executar o PostgreSQL e iniciar \`npm run dev\`, acesse \`/console\` com o token Bearer na Visão geral. Abra **Central de prioridades**, escolha uma categoria e clique **Atualizar prioridades**. Crie um lembrete de teste com vencimento próximo, aguarde o backend marcá-lo \`DUE\`, e atualize a central para verificar se ele aparece como **Alta**. Para testar decisões, use o fluxo de propostas V22; propostas expiram em 15 minutos. Para testar alertas, use o painel de workflows existente.

Execute \`npm run typecheck && npm test && npm run build\` quando estiver no ambiente. O pipeline do GitHub valida filtros, prioridade relativa, exclusões, privacidade entre usuários e a persistência real do PostgreSQL. A conexão Google OAuth V18 e o funcionamento visual local ainda precisam ser testados por você.

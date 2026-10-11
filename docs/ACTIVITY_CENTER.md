# CORTEX V25 — Central de Atividades do NEURON

A V25 reúne em uma única tela uma **projeção cronológica somente para leitura** de quatro tipos de registros já existentes no PostgreSQL:

- **Lembretes internos:** criação, vencimento, conclusão e cancelamento, quando houver timestamps persistidos.
- **Propostas de agenda:** criação, aprovação/rejeição, aplicação V23 e reversão V24. Cada etapa registrada possui uma linha própria, se seu timestamp existir.
- **Notificações persistentes de workflows:** criação e visualização, sem executar workflows nem alterar notificações.
- **Auditoria de ferramentas:** resultado das execuções registradas, exibindo apenas o nome da ferramenta e se houve sucesso/falha. Entradas, resultados e mensagens de erro não são enviados para a tela.

## Usar no painel

Atualize o Codespaces, inicie PostgreSQL e o servidor, abra \`/console\` e selecione **Central de atividades**. Escolha a categoria **Todas**, **Lembretes**, **Decisões e agenda**, **Notificações persistidas** ou **Auditoria de ferramentas**. Escolha 20, 30, 50 ou 100 eventos por consulta. O botão **Atualizar atividades** executa outra leitura. A ordem é decrescente por data, com ordenação estável por categoria/estado/identificador de evento em empates.

O botão não aprova decisões, não marca notificações como lidas e não executa ferramentas. É apenas uma consulta a dados já registrados. O filtro e o limite são encaminhados como parâmetros validados, sem SQL construído a partir de textos do usuário.

## API e segurança

\`GET /api/activity?category=all|reminders|agenda|notifications|tools&limit=30\`

- Exige **PostgreSQL** e \`CORTEX_API_TOKEN\` configurado mesmo no ambiente de testes; caso contrário, responde \`503\`.
- A API exige autenticação Bearer e utiliza exclusivamente o \`CORTEX_USER_ID\` definido no servidor. Não aceita \`userId\` no pedido.
- Limites de 1 a 100, filtros válidos somente, \`400\` nos demais casos.
- Responde \`{entries,category,limit,truncated,readOnly:true,source:"cortex-postgresql",timeZone,disclaimer}\`, com \`Cache-Control: private, no-store\`. \`truncated=true\` informa que a resposta omitiu entradas mais antigas dentro da categoria consultada. **Não é um histórico exaustivo de todas as ações**.
- Os títulos de lembretes e propostas são **privados** e permanecem no navegador do usuário após a consulta. Mantenha o Codespaces privado e proteja a conexão. Conteúdos recebidos da API são exibidos com \`textContent\`, sem interpretar HTML externo.
- Não há armazenamento adicional, agendamento automático, rastreamento de navegação, envio de dados para modelos de IA, sincronização com Google Agenda ou exportação automática de atividades.

**Cobertura limitada:** não apresenta todas as mudanças de workflows nem um histórico universal de autenticação. A auditoria de ferramentas foi projetada para não expor entradas/saídas e textos de erros. Os eventos pré-existentes dependem da retenção das tabelas de origem; se a aplicação de origem não registrou uma transição, ela não aparecerá retroativamente.

## Testes

GitHub Actions executa TypeScript, testes Vitest com PostgreSQL e build. Novos testes verificam: filtros, recusa a parâmetros inválidos, isolamento por usuário, combinações dos quatro tipos, ordenação, limite de resultados, não exposição de detalhes internos de erro e leitura sem efeitos colaterais. A validação visual no seu Codespaces pode ser realizada mais tarde.

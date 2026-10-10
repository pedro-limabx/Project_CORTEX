# CORTEX V18 — Google Agenda (somente leitura)

A V18 adiciona **acesso opcional e supervisionado ao Google Agenda**. OAuth 2.0 Authorization Code + PKCE S256, escopo exclusivo \`https://www.googleapis.com/auth/calendar.events.readonly\`, tokens criptografados em PostgreSQL (AES-256-GCM, chave local de 32 bytes), estado OAuth de uso único e timeout de dez minutos. Nenhum evento é criado, alterado ou excluído.

## Antes de configurar

1. Tenha PostgreSQL funcionando e configure um \`CORTEX_API_TOKEN\` forte (32+ caracteres) em \`.env\`. O backend **não permite** conexão Google sem esse token, mesmo em desenvolvimento.
2. No [Google Cloud Console](https://console.cloud.google.com/), crie/selecione um projeto, habilite a **Google Calendar API**, configure a tela de consentimento OAuth e adicione seu próprio e-mail aos **usuários de teste** quando necessário.
3. Em Credenciais, crie um **OAuth 2.0 Client ID** do tipo **Web application**. Copie **Client ID** e **Client secret** para \`.env\` (NUNCA no GitHub ou no navegador).
4. Defina uma única **URI de redirecionamento autorizada** igual, caractere por caractere, à variável \`GOOGLE_CALENDAR_REDIRECT_URI\`, por exemplo:
   - Desenvolvimento local: \`http://localhost:3000/api/integrations/google-calendar/callback\`
   - HTTPS Codespaces: \`https://SEU-CODESPACE-3000.app.github.dev/api/integrations/google-calendar/callback\`
5. Gere a chave de armazenamento: \`openssl rand -hex 32\`. Copie a saída para \`GOOGLE_CALENDAR_ENCRYPTION_KEY\`. Mantenha esta chave privada; mudá-la invalida as credenciais previamente armazenadas.
6. Complete as variáveis abaixo no \`.env\` da sua máquina/Codespaces:

\`\`\`dotenv
CORTEX_API_TOKEN=<sua-chave-aleatória-de-pelo-menos-32-caracteres>
GOOGLE_CALENDAR_CLIENT_ID=<id>.apps.googleusercontent.com
GOOGLE_CALENDAR_CLIENT_SECRET=<segredo>
GOOGLE_CALENDAR_REDIRECT_URI=https://SEU-CODESPACE-3000.app.github.dev/api/integrations/google-calendar/callback
GOOGLE_CALENDAR_ENCRYPTION_KEY=<64-caracteres-hex-da-chave>
\`\`\`

7. Mantenha a porta do Codespaces **Private**, não pública. A página do callback pode solicitar autenticação GitHub na passagem pelo proxy do Codespaces. Verifique a URI real na aba **Ports**: URLs do Codespaces podem mudar ao recriar o ambiente. Consulte a documentação oficial sobre encaminhamento de portas.
8. Reinicie \`npm run dev\`, abra \`/console\`, configure o token na aba Visão Geral, clique em **Google Agenda → Conectar Google Agenda → Continuar no Google**. Autorize o escopo de leitura, volte à aba original e clique **Verificar conexão**. Então clique em **Consultar no Google**.

## API e privacidade

- \`GET /api/integrations/google-calendar/status\`: não revela tokens. Se \`configured=false\`, o restante do CORTEX continua funcionando.
- \`POST /api/integrations/google-calendar/connect\`: inicia autorização (requer Bearer e corpo \`{}\`); retorna URL temporária do Google com state e code_challenge.
- \`GET /api/integrations/google-calendar/callback\`: rota de retorno do Google; usa state randômico previamente registrado na base; não exige Bearer porque o Google não pode conhecê-lo. Nunca confie em um parâmetro \`user_id\` vindo desse retorno.
- \`GET /api/integrations/google-calendar/events?period=today|tomorrow|week\`: retorna até 50 eventos do **calendário principal**, com títulos e horários, usando o fuso São Paulo para definir janelas. Outras páginas são indicadas como \`truncated\`; não são omitidas silenciosamente.
- \`POST /api/integrations/google-calendar/disconnect\` com \`{"confirmed":true}\`: apaga tokens e autorizações pendentes do CORTEX. Isso **não revoga** o consentimento dado no Google. Para revogá-lo, visite a seção de apps com acesso à conta nas configurações da sua Conta Google.

Os tokens ficam somente no servidor, criptografados no PostgreSQL, nunca na resposta da API nem no navegador. Uma credencial de refresh pode permitir acesso contínuo mesmo após fechar o browser; mantenha o banco, a chave e o token da API protegidos. **Não disponibilize a porta do Codespaces como pública** com autenticação ausente. O callback é sensível: os logs do backend ocultam URLs de requisição que podem conter códigos temporários. Não grave secret, state, authorization code ou token em logs.

As chamadas são somente para endpoints HTTPS fixos do Google. O Google pode limitar quotas ou exigir configuração de OAuth e verificação conforme a situação do aplicativo. Em modo de teste, tokens de atualização podem expirar segundo políticas do Google. Nada nessa versão inclui sincronização bidirecional, alteração de calendário, calendário secundário, importação de eventos para o PostgreSQL, execução autônoma ou notificações push. Os eventos são consultados **somente após comando explícito no painel**.

## Testes

\`npm run typecheck && npm test && npm run build\` verifica unidades e integração PostgreSQL com respostas Google simuladas. Não há testes de ponta a ponta com conta Google real sem suas credenciais e consentimento. Não cole segredos nesta conversa.


## V19 — Consultas de eventos Google no NEURON Chat

A V19 usa a conexão OAuth opcional da V18 para responder no chat a perguntas explícitas, por exemplo:

- `Quais reuniões tenho amanhã?`
- `NEURON, quais reuniões tenho hoje?`
- `Quais eventos tenho no Google Agenda hoje?`
- `Mostre meus eventos do Google nos próximos 7 dias`
- `O que tenho no Google Agenda amanhã?`

Há um botão **Google amanhã** no NEURON Chat. O clique coloca a pergunta no mesmo fluxo de mensagens, sem sobrescrever rascunhos. Comandos são reconhecidos por padrões determinísticos e limitados a **hoje, amanhã e próximos 7 dias (incluindo hoje)**, em horário civil de São Paulo. Não há interpretação geral por IA nem consulta automática sem uma pergunta enviada por você.

Se o Google não estiver configurado ou autorizado, o chat mostra uma orientação e um atalho para a aba Google Agenda, sem fingir que existe uma conexão. Para períodos não reconhecidos, como “sexta-feira que vem”, o NEURON solicita reformulação em vez de inventar resultados. Erros de conexão ou autorização são comunicados claramente.

A resposta tem `mode=google-calendar-readonly` e `googleAgenda: {source:"google-calendar",readOnly:true,events,truncated,...}`. É uma consulta real ao calendário **principal** do Google, usando exclusivamente o escopo de leitura da V18. Ela não altera eventos no Google, não cria lembretes no CORTEX e não usa o conteúdo de eventos como comandos para ferramentas, workflows ou LLMs. Renovação de token OAuth pode atualizar apenas as credenciais criptografadas locais. Informações do Google aparecem identificadas separadamente dos lembretes do banco interno.

São retornados no máximo 50 eventos por consulta, com indicador de paginação quando o Google informar mais resultados; a resposta em texto resume no máximo 10. Perguntas sobre **reuniões** consultam todos os eventos do período, pois o Google não distingue automaticamente reuniões de outros compromissos pela estrutura da agenda. A V19 não sincroniza ou unifica permanentemente os dois calendários e não envia eventos para outras integrações.

**Pré-requisito:** concluir a configuração OAuth da V18 e conectar sua conta pelo painel. Testes automatizados usam um provedor simulado; uma conta Google real só será acessada com sua autorização.


## V20 — Agenda Unificada (NEURON Chat e API)

A V20 oferece uma **consulta pontual e somente leitura** dos lembretes CORTEX (registros persistidos e recorrências futuras previstas) e eventos do **calendário principal** do Google quando OAuth V18 estiver ativo. Perguntas explícitas incluem:

- `Minha agenda completa de hoje`
- `Minha agenda unificada de amanhã`
- `Mostre tudo que tenho agendado hoje`
- `Junte meus lembretes e eventos do Google amanhã`
- `Minha agenda completa dos próximos 7 dias`

O botão **Agenda completa hoje** no NEURON Chat envia uma consulta após clique, protegendo rascunhos não enviados.

A API `GET /api/agenda/unified?period=today|tomorrow|week` reutiliza a consulta autenticada e limitada da V16 e a conexão Google somente leitura da V18. Dados de ambos são identificados com `sources` (`cortex`, `google` ou ambos). Apenas eventos cronometrados com **título normalizado e instante UTC idênticos** são apresentados numa mesma linha, marcando as duas origens; eventos de dia inteiro não são fundidos automaticamente. Isso não representa identidade garantida do compromisso — títulos e horários iguais podem ser coincidências. Nenhuma entrada é apagada ou alterada na origem.

**Sem Google configurado ou conectado:** continua mostrando os lembretes locais, avisando explicitamente que o Google não foi consultado. Falha ou expiração da autorização também produz aviso, preservando a agenda local. A API retorna `google` com o estado da conexão e `warnings` de possível incompletude, sem expor detalhes de OAuth.

O calendário usa a zona civil `America/Sao_Paulo`; os eventos externos de dia inteiro mantêm a data sem conversão de fuso. Respostas de texto resumem até 10 resultados; a visualização oferece até 50 itens mesclados, podendo ser parcial porque o CORTEX limita a leitura a 30 entradas e o Google a 50. A propriedade `truncated` sinaliza limites ou paginação de qualquer origem. Não há sincronização, escrita, importação automática, persistência de eventos externos, execução de ferramentas nem envio de eventos a um LLM. Apenas a renovação de credenciais OAuth já autorizadas pode atualizar o armazenamento de tokens.

Se o PostgreSQL interno estiver indisponível, a consulta unificada retorna 503, em vez de inventar lembretes. Perguntas fora de hoje, amanhã e próximos 7 dias recebem orientação. Esta versão **não estabelece** uma conta Google real: a configuração OAuth e o consentimento precisam ser concluídos no Codespaces para obter eventos do Google.

## V21 — Análise de conflitos na agenda (somente leitura)

A V21 permite perguntar ao NEURON Chat: **Tenho conflitos na agenda amanhã?**, **Verifique conflitos na agenda hoje** ou **Analise sobreposições na agenda nos próximos 7 dias**. Há um atalho **Conflitos amanhã** que não descarta rascunhos.

A API autenticada GET /api/agenda/conflicts?period=today|tomorrow|week reutiliza a V20 e devolve conflitos, sugestões, contagens e avisos. As operações apenas leem a agenda, sem modificar o CORTEX ou o Google.

Regras conservadoras:
- Dois eventos Google com início e término válidos que compartilham tempo são classificados como sobreposição **confirmada de eventos**.
- Um lembrete pontual do CORTEX durante um evento Google gera um **possível conflito**, porque não se conhece a duração do lembrete. Recorrências ainda não executadas são previsões.
- Um registro já combinado CORTEX+Google não entra em conflito consigo mesmo.
- Eventos de dia inteiro não são automaticamente considerados 24 horas ocupadas e exigem atenção manual. Eventos sem fim válido geram aviso de análise incompleta.
- Até 20 conflitos por consulta são apresentados. Os 50 itens da V20 e a paginação das fontes podem reduzir a cobertura; isso é explicitamente sinalizado.

Até quatro **sugestões tentativas de 30 minutos** entre 9h e 18h, no horário de São Paulo, evitam intervalos ocupados e lembretes conhecidos. Dias com eventos de dia inteiro são excluídos dessas sugestões. Não existe uma consulta completa de disponibilidade nem garantia de horário vago, especialmente quando o Google está desconectado ou o resultado é parcial. O usuário deve verificar o calendário antes de alterar sua agenda.

A análise não envia dados de eventos para um LLM nem autoriza reagendamento, exclusão, criação, notificação automática ou sincronização. OAuth segue com escopo apenas de leitura. Sem PostgreSQL retorna HTTP 503. Sem Google conectado, consulta só o CORTEX e avisa a limitação.


## V22 — Propostas supervisionadas de reorganização (sem edição automática)

A V22 converte conflitos detectados na V21 em **propostas de reorganização que dependem de revisão humana**, com registro persistente das decisões no PostgreSQL.

1. No NEURON Chat, pergunte: `Tenho conflitos na agenda amanhã?`.
2. Nos resultados, escolha **Preparar plano** para o compromisso específico. O CORTEX consulta a agenda novamente e verifica o conflito; se tiver mudado ou se a consulta estiver incompleta, recusa a geração em vez de prosseguir com dados obsoletos.
3. Abra **Propostas de agenda** para comparar horário original e alternativa, com indicação da fonte CORTEX/Google.
4. Escolha **Aprovar plano** ou **Rejeitar**. Uma confirmação explícita é obrigatória.

**Aprovação não é execução:** aprovar significa concordar com a proposta registrada para revisão futura. Não altera o Google Agenda nem o horário de qualquer lembrete CORTEX. Para aplicar a alteração, o usuário ainda precisa fazê-la manualmente no sistema correspondente. Esta limitação é intencional: OAuth V18 continua com `calendar.events.readonly`. Não há novas permissões de escrita nem operações externas ocultas.

As propostas preservam a duração real dos eventos Google. Para lembretes pontuais, o novo horário permanece **pontual**, sem inventar término; o cálculo apenas reserva uma margem hipotética de 30 minutos ao procurar alternativas. Os horários tentativos são pesquisados na **mesma data**, em passos de 30 minutos entre 9h e 18h em `America/Sao_Paulo`, evitando intervalos já conhecidos como ocupados e instantes com lembretes. Não há garantia de disponibilidade. Eventos de dia inteiro, eventos com duração desconhecida, fontes Google desconectadas, agendas truncadas, conflitos obsoletos ou recorrências ainda não materializadas impedem a criação automática de um plano seguro.

**API autenticada e armazenamento:**

- `GET /api/agenda/proposals?limit=30`: lista somente os planos associados ao usuário controlado pelo servidor.
- `POST /api/agenda/proposals`: JSON `{"period":"tomorrow","conflictKey":"<32 caracteres hex>","targetId":"<ID da análise>","confirmed":true}`. Recalcula o conflito e escolhe a alternativa exclusivamente no backend; não aceita horários ou títulos fornecidos pelo navegador.
- `POST /api/agenda/proposals/:id/approve` ou `/:id/reject`: JSON exato `{"confirmed":true}`. Transição atômica de `PENDING_REVIEW` para `APPROVED` ou `REJECTED`, sem duplicidade e sem alteração de compromissos.

O banco guarda título, horários original/sugerido, estado, identidade do usuário, data da decisão e validade. Cada proposta pendente vence após **15 minutos** e não pode mais ser aprovada ou rejeitada após o vencimento; gere uma nova consulta. Há limite de 50 propostas pendentes por usuário. Como há gravação de decisões, a V22 exige **PostgreSQL e CORTEX_API_TOKEN configurados**, mesmo em desenvolvimento. Mantenha a porta do Codespaces privada. Dados do Google armazenados nas propostas ficam no seu PostgreSQL; proteja o banco e os backups. Nenhum evento do Google é usado como instrução de IA.

A conexão Google real ainda depende de configurar OAuth e autorizar sua conta. O teste automatizado do fluxo utiliza dados sintéticos e o PostgreSQL de testes; isso não valida acesso real ao Google.

## V23 — Aplicação supervisionada de propostas aos lembretes CORTEX

A partir da V23, um plano V22 **aprovado** e ainda válido pode ser **aplicado a um lembrete interno do CORTEX**, mediante uma **segunda confirmação explícita**. O Google Agenda permanece rigorosamente em modo somente leitura: planos para eventos Google continuam apenas orientativos.

Fluxo: gere um conflito (V21), prepare uma proposta (V22), **aprove** o plano, abra **Propostas de agenda** e clique **Aplicar horário ao lembrete CORTEX**. Uma mensagem confirma que o horário real do lembrete será modificado no PostgreSQL. Se o servidor detectar que algo mudou, a aplicação é recusada com erro 409; faça nova análise.

A API `POST /api/agenda/proposals/:id/apply` exige o mesmo Bearer `CORTEX_API_TOKEN` e corpo JSON **exato** `{"confirmed":true}`. O servidor não aceita novos horários nesse pedido. Os dados usados vêm do plano persistido, associado ao `CORTEX_USER_ID`, com os seguintes bloqueios:

- apenas propostas com estado `APPROVED`, não utilizadas e com expiração futura (15 minutos após a criação);
- somente `source="cortex"`, sem origem Google combinada ou recorrência projetada;
- o lembrete original deve existir, pertencer ao usuário, manter mesmo título/instante e continuar `PENDING`; lembretes `DUE`, concluídos ou cancelados não são alterados;
- a agenda unificada é consultada novamente: o Google precisa estar conectado, sem paginação parcial, o conflito original ainda deve existir e a sugestão recalculada deve coincidir com a proposta aprovada;
- a alternativa precisa continuar no futuro e não pode coincidir com outro lembrete interno no mesmo intervalo de 30 minutos.

A atualização do lembrete e a marcação `APPLIED` na proposta são executadas na **mesma transação PostgreSQL**, com compare-and-swap e trava de linha. Requisições concorrentes ou repetidas não podem aplicar o mesmo plano duas vezes. Um erro reverte a transação. O histórico da proposta armazena `appliedAt`, e o estado `APPLIED` é adicionado por migração automática da restrição de estados V22 ao iniciar o servidor.

**Limitações:** não há desfazer automático, nem alteração de eventos Google, regras recorrentes ou convites externos. Revalidação de agenda é uma fotografia: um evento Google pode ser alterado externamente logo após a consulta; confirme os compromissos no Google. A criação de uma recorrência por outro worker também pode mudar a disponibilidade após a verificação. Dados do Google podem continuar no banco como parte do registro de proposta; proteja os backups. A conexão OAuth Google precisa ser ativada no Codespaces e o `CORTEX_API_TOKEN` deve estar configurado.


## V24 — Histórico e reversão supervisionada de alterações internas

A V24 adiciona a aba **Histórico da agenda**, que apresenta mudanças efetivamente aplicadas pela V23 a **lembretes internos**. O histórico consulta diretamente os registros persistentes de propostas V23 no PostgreSQL, preservando o horário antigo, o horário aplicado, o título, o instante da aplicação e, quando houver, a data da reversão. Registros `APPLIED` e `REVERTED` são apresentados mesmo após o vencimento do prazo de reversão. Não é um histórico universal de todas as edições do sistema: nesta versão, registra as operações supervisionadas originadas na V23.

Para desfazer um reagendamento, abra **Histórico da agenda → Analisar reversão**. O servidor retorna uma **prévia** com elegibilidade, motivo, horário atual e horário anterior. Apenas depois da prévia elegível o navegador pede **confirmação explícita** para restaurar o horário no PostgreSQL. Uma nova revalidação ocorre também no momento do POST, de modo que uma prévia antiga não autoriza uma execução posterior sem novas verificações.

**Critérios de segurança**: reversão disponível por **30 minutos contados da aplicação**; mudança ainda marcada `APPLIED`; lembrete original existente, pertencente ao usuário, ainda `PENDING`, com título e horário atual inalterados; o horário anterior deve continuar mais de 1 minuto no futuro; consulta da semana não pode estar parcial e exige Google Agenda conectado. O intervalo de 30 minutos iniciado no horário antigo não pode ter outro lembrete, evento Google sobreposto, evento de dia inteiro ou evento Google sem duração confiável nessa data. Caso contrário, a solicitação é recusada. Portanto, **uma proposta válida para desfazer não garante que a reversão será possível**: se o conflito original continuar existindo, o CORTEX impede o retorno ao mesmo conflito.

Endpoints com Bearer `CORTEX_API_TOKEN`, PostgreSQL e isolamento por `CORTEX_USER_ID`:

- `GET /api/agenda/history?limit=30` — consulta até 50 alterações `APPLIED`/`REVERTED`, sem revelar eventos Google.
- `GET /api/agenda/history/:id/undo-preview` — prévia somente leitura, retornando `eligible`, `reason` e os dois horários.
- `POST /api/agenda/history/:id/undo` com corpo **exato** `{"confirmed":true}` — restaura o horário antigo exclusivamente para um lembrete interno, usando revalidação da agenda e uma transação PostgreSQL. Altera `due_at` do lembrete e o estado da proposta de `APPLIED` para `REVERTED`, registrando `revertedAt`. O mesmo plano não pode ser revertido duas vezes; requisições concorrentes deixam apenas uma vencer.

A inicialização do PostgreSQL migra a restrição de status para incluir `REVERTED` **sem apagar os planos anteriores**. A consulta ao Google permanece exclusivamente de leitura (OAuth V18) e nenhum evento externo é alterado. Nenhuma recorrência, lembrete concluído, vencido ou cancelado pode ser revertido por essa operação. As verificações usam uma fotografia atual da agenda e bloqueio transacional no banco; alterações externas simultâneas no Google ainda são possíveis, de modo que a disponibilidade nunca pode ser garantida. A conta OAuth real continua exigindo ativação e consentimento no Codespaces.

Para testar sem utilizar dados pessoais, rode `npm run typecheck && npm test && npm run build`. Testes PostgreSQL verificam histórico do usuário, atualização e reversão atômicas, repetição, concorrência, expiração e interferência de outros lembretes. A validação prática de ponta a ponta com uma conta Google autorizada continua pendente.

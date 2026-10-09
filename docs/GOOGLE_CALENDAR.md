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

# Segurança

## Regras

- O modelo não é uma autoridade de segurança.
- Ferramentas possuem risco e permissões.
- HIGH/CRITICAL exigem aprovação explícita.
- Segredos ficam fora do código.
- Conteúdo externo é não confiável.
- Ações devem ser verificadas após execução.
- Operações financeiras reais ficam bloqueadas até existir integração oficial e sandbox/testes.

## Ameaças prioritárias

- prompt injection;
- tool injection;
- vazamento de secrets;
- execução arbitrária;
- replay/duplicidade;
- autorização insuficiente;
- falhas de terceiros.

## Autenticação atual

- `CORTEX_API_TOKEN` habilita autenticação Bearer nas rotas `/api/chat` e `/api/tools`.
- O token deve ter pelo menos 32 caracteres; em `NODE_ENV=production`, sua ausência impede a inicialização.
- A comparação do token usa `timingSafeEqual` após validar o tamanho.
- `CORTEX_USER_ID` define a identidade no servidor. O `userId` enviado pelo cliente é ignorado.
- Permissões e aprovações enviadas no corpo da requisição não são aceitas.
- Sem token em desenvolvimento, as rotas permanecem abertas para facilitar testes locais. Não exponha esse modo à rede pública.

Esta é uma autenticação por token compartilhado para uma instalação de usuário único, não um sistema de contas multiusuário. Rotação de tokens, rate limiting e RBAC persistente ainda não existem.

## Próximas etapas de segurança

Adicionar rotação segura de tokens, rate limiting, fluxo confiável de aprovação, políticas de retenção da auditoria e sandbox para execução de computador.

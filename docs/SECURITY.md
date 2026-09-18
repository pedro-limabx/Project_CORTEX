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

## Próxima etapa

Adicionar autenticação, RBAC/ABAC, auditoria persistente, rate limiting e sandbox para execução de computador.

# CORTEX — Identidade visual e vídeo de inicialização

A interface usa a logo do cérebro/circuitos ao lado de **CORTEX / LABORATÓRIO OPERACIONAL** e exibe o vídeo de abertura sempre que `/console` é carregado/recarregado.

## Instalar as mídias

A branch inclui o código da interface e as rotas para os recursos estáticos. Por serem mídias binárias fornecidas no chat, **os arquivos devem ser copiados uma vez para a pasta** `web/assets/` do projeto:

- `web/assets/cortex-logo.png` — emblema branco de cérebro e circuitos, sem estrela e com fundo transparente, versionado no GitHub.
- `web/assets/cortex-intro.mp4` — vídeo original de aproximadamente **10 segundos**, sem redução da duração.

O pacote de mídia entregue no chat contém os dois arquivos na estrutura `web/assets/`. No Codespaces, envie o ZIP para a raiz do projeto e execute `unzip -o cortex-branding-assets.zip` antes de iniciar o servidor. Outra opção é arrastar os arquivos diretamente para `web/assets/` no VS Code.

**IMPORTANTE:** a nova logo PNG já acompanha o código do GitHub, sem precisar copiar imagens manualmente. O vídeo enviado permanece como mídia local separada: a *animação enviada* só aparece quando `cortex-intro.mp4` estiver efetivamente instalado. Sem vídeo, há um fallback de 1,8 segundo. É necessário incluir os binários no Codespaces ou no deploy permanente; o código não pode recuperar automaticamente anexos privados do ChatGPT.

## Diagnóstico de HTTP 404 (Codespaces)

O servidor pode responder `200` em `/health` mesmo se um **processo antigo** continuar ocupando a porta 3000 e não tiver as rotas de mídia. A presença de arquivos em `web/assets` não atualiza automaticamente um Node que já carregou módulos antigos. O `tsx watch` reinicia seu próprio processo ao detectar alterações, mas não encerra outros processos da mesma porta.

Use:

```bash
cd /workspaces/Project_CORTEX
git switch main
git pull --ff-only origin main
npm run doctor:branding
```

O diagnóstico compara os arquivos e as rotas presentes no checkout local com os resultados GET efetivamente atendidos pelo servidor, diferenciando:

- `route_not_registered`: resposta 404 `Route GET:/console/media/...`, em geral processo/versão antiga.
- `file_not_found_by_server`: rota carregada, mas servidor sem acesso ao arquivo (diretório de trabalho diferente ou arquivo ausente).
- `unreachable`: porta sem servidor em execução (ou HOST/PORT diferente).
- `available`: recurso entregue em HTTP 200 ou 206, investigar cache/configuração do navegador.

Após identificar um processo antigo, use `ss -lntp | grep ':3000'` para examinar o PID, pare o **terminal daquele processo** com Ctrl+C e só então execute `npm run dev` da raiz. Não mate processos indiscriminadamente. A rota `/health` também informa `capabilities.brandingMediaRoutes=true` quando o backend atualizado está atendendo.

O script é somente leitura, não envia credenciais e não altera processos, arquivos nem dados do usuário.

## Regras da abertura

- O vídeo é tentado a cada entrada/recarregamento da página do painel, **não** a cada reinício de um processo Node.js sem página aberta. O botão **Rever abertura** recarrega o painel para testá-lo novamente (rascunhos não enviados não são preservados).
- Autoplay sempre mudo (`muted`) e `playsinline`; não há controles nem repetição (`loop`).
- `ended` revela o painel normalmente. O botão **Pular animação** encerra imediatamente.
- Falhas ao carregar ou bloqueio de reprodução acionam uma animação visual curta; há watchdog de 15 segundos contra tela bloqueada.
- A preferência de redução de movimento **não bloqueia** a abertura, conforme solicitação do proprietário. Sempre há um botão de pular, fallback curto e limite máximo de 15 segundos.
- A URL do vídeo oferece suporte a requisições HTTP `Range` (206/416), permitindo seek/cache parcial conforme o navegador.
- `media-src 'self'` na CSP permite somente mídia same-origin. Não são reveladas chaves de IA, tokens ou credenciais pelo navegador.

Nenhuma operação de IA, ferramenta ou workflow é iniciada pela splash screen. A abertura é apenas apresentação.

# CORTEX — Identidade visual e vídeo de inicialização

A interface usa a logo do cérebro/circuitos ao lado de **CORTEX / LABORATÓRIO OPERACIONAL** e exibe o vídeo de abertura sempre que `/console` é carregado/recarregado.

## Instalar as mídias

A branch inclui o código da interface e as rotas para os recursos estáticos. Por serem mídias binárias fornecidas no chat, **os arquivos devem ser copiados uma vez para a pasta** `web/assets/` do projeto:

- `web/assets/cortex-logo.webp` — logo recortada da imagem original, com fundo preto preservado.
- `web/assets/cortex-intro.mp4` — vídeo original de aproximadamente **10 segundos**, sem redução da duração.

O pacote de mídia entregue no chat contém os dois arquivos na estrutura `web/assets/`. No Codespaces, envie o ZIP para a raiz do projeto e execute `unzip -o cortex-branding-assets.zip` antes de iniciar o servidor. Outra opção é arrastar os arquivos diretamente para `web/assets/` no VS Code.

**IMPORTANTE:** a implementação no GitHub funciona sem as mídias com um fallback visual por 1,8 segundo; a *animação enviada* só aparece quando `cortex-intro.mp4` estiver efetivamente instalado. Sem `cortex-logo.webp`, a barra lateral mantém o ícone anterior. É necessário incluir os binários no Codespaces ou no deploy permanente; o código não pode recuperar automaticamente anexos privados do ChatGPT.

## Regras da abertura

- O vídeo toca a cada entrada/recarregamento da página do painel, **não** a cada reinício de um processo Node.js sem página aberta.
- Autoplay sempre mudo (`muted`) e `playsinline`; não há controles nem repetição (`loop`).
- `ended` revela o painel normalmente. O botão **Pular animação** encerra imediatamente.
- Falhas ao carregar ou bloqueio de reprodução acionam uma animação visual curta; há watchdog de 15 segundos contra tela bloqueada.
- `prefers-reduced-motion` evita a abertura em dispositivos com redução de movimento ativada.
- A URL do vídeo oferece suporte a requisições HTTP `Range` (206/416), permitindo seek/cache parcial conforme o navegador.
- `media-src 'self'` na CSP permite somente mídia same-origin. Não são reveladas chaves de IA, tokens ou credenciais pelo navegador.

Nenhuma operação de IA, ferramenta ou workflow é iniciada pela splash screen. A abertura é apenas apresentação.

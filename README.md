# Concord

Compartilhamento de tela para um grupo fechado de amigos, feito para conviver com o Discord: a voz
e o chat continuam lá; o Concord transmite a tela (com o som do jogo) por um servidor
[LiveKit](https://livekit.io) próprio, sem VPN.

- **App desktop** (Windows 10/11, Electron): fica na bandeja e abre uma janela com visual
  inspirado no Discord para assistir ou transmitir.
- **Servidor** (`concord-api` + `livekit-server` + Caddy): roda numa VM **Oracle Cloud Always
  Free**, atrás de um domínio com HTTPS (DuckDNS + Let's Encrypt).

Como instalar e usar (guia para os amigos): [docs/INSTALAR.md](docs/INSTALAR.md). Último
instalador: [releases/latest](https://github.com/bryanljf/Concord/releases/latest).

## Funcionalidades

- **Login com Discord** (OAuth2, escopo `identify`) restrito a uma lista de IDs autorizados.
  Nome e foto vêm do Discord e são atualizados sozinhos; cada um pode definir um apelido.
- **Salas** fixas (Sala 1, 2 e 3) com presença em tempo real: quem está em cada sala e quem
  está **AO VIVO**, mesmo para quem está fora da sala. A barra lateral recolhe numa coluna de
  ícones (o logo do Concord no topo): ponto verde se há gente (quem está aparece ao passar o
  mouse), ponto vermelho piscando se há live, fone se há música.
- **Transmitir** uma janela ou uma tela inteira em Leve (720p30), Padrão (1080p30) ou Jogo
  (1080p60), H.264 com simulcast; quando falta CPU a resolução cai antes da taxa de quadros.
  **Áudio por processo**: só o som do aplicativo, sem a call do Discord
  (WASAPI Process Loopback). **Trocar fonte** durante a live sem derrubar quem assiste.
- **Webcam** com escolha de dispositivo (botão **Câmera** na barra de baixo e Configurações →
  Câmera), publicada à parte da tela: quem assiste escolhe ver a tela, a câmera ou as duas.
- **Assistir sob demanda**: ao entrar numa sala nada é baixado; cada live e cada câmera aparece
  como cartão com **Assistir**. Com duas ou mais assistidas, elas ficam numa **grade** de duas
  colunas (todas as telas com som, cada uma com seu volume); a vaga ímpar oferece
  **Transmitir**. Clique num bloco para o **destaque** (qualidade cheia e áudio, as outras em
  miniatura, câmeras incluídas) e volte à grade pelo botão ou `Esc`. Menu de clique direito
  (destacar, voltar à grade, pop-out, câmeras em picture-in-picture, silenciar, estatísticas,
  parar de assistir), volume por live (padrão 50%, máximo 100%) e tela cheia.
- **Pop-out**: a live abre numa janela própria com os mesmos controles do destaque (somem
  sozinhos), sempre no topo e tela cheia; a janela principal mostra um aviso no lugar do vídeo
  em vez de baixar a mesma live duas vezes.
- **Picture-in-picture das câmeras**: todas as câmeras assistidas numa janelinha que abre no
  canto superior direito, por cima de qualquer app (inclusive jogos em tela cheia sem bordas;
  desligável pelo menu dela), arrastável, redimensionável até 1/6 da tela e com tela cheia. Não
  aparece nas transmissões nem em capturas de tela.
- **Estatísticas da transmissão** (menu de clique direito): perda de pacotes e fps dos últimos
  30 s, resolução, codec, conexão, os números do encoder de quem transmite (captura, codificação
  e envio) e uma lista de possíveis problemas, com **Copiar diagnóstico** para relatar bugs.
  Cada app publica um resumo do próprio envio nos atributos do LiveKit (`concord.stats.screen` e
  `concord.stats.camera`).
- **Música do Spotify**, à parte da tela (aba **Música** do seletor; só o Spotify por enquanto):
  o áudio do processo do Spotify vai numa faixa própria (fonte Microphone do LiveKit, nome
  `concord:music:spotify`; o app nunca usa o microfone), em Opus estéreo até 320 kbps, com o
  bitrate caindo em degraus quando o upload perde pacotes ou enfileira e voltando sozinho. Música,
  artista, capa e posição vêm dos controles de mídia do Windows (SMTC, num `utilityProcess`) e
  chegam a quem ouve pelo atributo `concord.music` e pela RPC `concord.music.art`. Quem ouve usa o
  ícone de fone na linha da sala: um painel com capa, progresso, **Ouvir** (uma música por vez) e
  volume de 1 em 1%. Um som próprio avisa quando alguém começa a transmitir música na sua sala.
- **Quem está assistindo**, como no Go Live do Discord: cada live (e a prévia da sua) mostra o
  número de espectadores e os avatares; passar o mouse lista os nomes. Cada app publica as lives
  que assiste num atributo do LiveKit (`concord.watching`).
- **Sons de aviso**: quando alguém entra ao vivo na sala em que você está (silenciável por sala
  ou pessoa); quando alguém começa ou para de assistir a sua live ou uma live que você assiste;
  e quando alguém (ou você) entra ou sai da sala. Os dois últimos se desligam em Configurações →
  Sons. Sem notificações do Windows para lives.
- **Bandeja e inicialização**: inicia com o Windows escondido, opcionalmente só enquanto o
  Discord está aberto; atalho global (`Ctrl+Shift+L`) para transmitir/parar.
- **Atualização automática**: o app verifica de hora em hora, baixa em segundo plano e avisa
  (notificação, item na bandeja e faixa "Reiniciar agora").

## Arquitetura

```
PC de cada amigo (Windows)                 VM Oracle (Ubuntu 24.04 ARM, Docker)
┌──────────────────────────────┐   HTTPS   ┌─────────────────────────────────────────────┐
│ Concord (Electron)           │──────────▶│ Caddy :443 (Let's Encrypt)                  │
│  main: bandeja, presença SSE,│           │  ├─ /api/*  → concord-api 127.0.0.1:3000    │
│        login Discord, update │   WSS     │  └─ resto   → livekit-server :7880 (WSS)    │
│  renderer: React + livekit-  │──────────▶│ livekit-server: mídia UDP 50000-50200,      │
│        client                │ UDP/TCP   │                 TCP 7881; webhooks → api    │
└──────────────────────────────┘──────────▶│ concord-api: OAuth Discord, tokens LiveKit, │
                                           │  presença (SSE), perfis, sync via bot       │
                                           └─────────────────────────────────────────────┘
```

- `apps/desktop`: Electron 44 + electron-vite + React 19. `src/main` (processo principal),
  `src/preload` (ponte IPC, contrato em `api.d.ts`), `src/renderer` (UI).
- `apps/api`: Fastify 5. Autenticação, tokens LiveKit restritos a compartilhamento de tela,
  presença por SSE alimentada por webhooks do LiveKit (com ressincronização a cada 60 s),
  perfis do Discord persistidos e apelidos.
- `packages/shared`: tipos e constantes comuns. `packages/process-audio`: adaptador do addon
  `loopback-capture` (áudio por processo, binário pré-compilado win32-x64).
- `infra/`: Terraform da VM (`infra/terraform`), `docker-compose.yml`, `Caddyfile`,
  `livekit.yaml` e o modo alternativo de hospedagem num PC Windows (`infra/local`).

## Operação

Passo a passo completo do servidor: [infra/README-deploy.md](infra/README-deploy.md).

| Tarefa                     | Como                                                                                                                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Liberar um amigo           | `pnpm --filter @concord/api user:add <id> <nome> --discord-id <ID do Discord>` no PC, copiar `infra/users.json` para `~/concord/infra/users.json` na VM e `docker compose -f infra/docker-compose.yml restart api`. |
| Mudar as salas             | `ROOMS=sala-1,sala-2,sala-3` em `~/concord/infra/.env` na VM e `docker compose -f infra/docker-compose.yml up -d api`. O app mostra `sala-1` como "Sala 1".                                                         |
| Atualizar o servidor       | Push em `main`: o workflow **CI** roda e, se passar, o **Deploy Oracle** entra na VM por SSH e executa `infra/scripts/deploy-oracle.sh`. Commits com `[skip ci]` não disparam nada.                                 |
| Publicar uma versão do app | Subir `version` em `apps/desktop/package.json`, criar e enviar a tag `vX.Y.Z` (igual à versão). O workflow **Release** gera `Concord-Setup-X.Y.Z.exe` e `latest.yml`, e os apps instalados atualizam sozinhos.      |
| Logs e consumo             | `ssh ubuntu@<IP da VM>` (o IP sai do `terraform output`), depois `cd ~/concord && docker compose -f infra/docker-compose.yml logs -f` e `docker stats`.                                                             |
| Infraestrutura             | `infra/terraform` (state e `terraform.tfvars` só no PC do administrador, fora do Git). A VM ignora mudanças de imagem e de cloud-init, então um `terraform apply` comum nunca a recria.                             |

Segredos ficam só na VM (`~/concord/infra/.env`: segredo do LiveKit, client secret e bot token
do Discord, segredo de sessão) e em `infra/users.json`; nada disso vai para o Git. No GitHub, o
environment `production` guarda a chave SSH de deploy, e a variável `ORACLE_DEPLOY_ENABLED`
liga o deploy automático.

## Capacidade medida

Teste de carga em 2026-10-13 contra a VM de produção (1 OCPU e 6 GB, Always Free), com
participantes simulados pela ferramenta do LiveKit. Nenhum cenário teve falha de conexão e a
perda de pacotes ficou em no máximo 0,008%.

| Cenário                            | CPU média / pico | Saída de rede |
| ---------------------------------- | ---------------- | ------------- |
| 1 transmissão, 9 espectadores      | 8% / 25%         | 21 Mbps       |
| 5 transmissões, 10 espectadores    | 16% / 37%        | 38 Mbps       |
| Estresse: 2 salas, 28 espectadores | 22% / 44%        | 50 Mbps       |

Cada sala aceita até 45 conexões (`room.max_participants` em `infra/livekit.yaml`): cada pessoa
usa até três (janela principal, pop-out e picture-in-picture). O deploy reinicia o LiveKit quando
esse arquivo muda. Se faltar
CPU, o Always Free permite subir para 2 OCPU e 12 GB mudando `ocpus` e `memory_in_gbs` no
Terraform.

## Desenvolvimento

Requisitos: Node 22+ e pnpm 12. Convenções do código em [CLAUDE.md](CLAUDE.md).

```bash
pnpm install
pnpm dev:livekit   # livekit-server local (binário oficial em infra/local/bin)
pnpm dev:api       # concord-api em http://127.0.0.1:3000 (lê infra/.env)
pnpm dev           # app desktop com hot reload
pnpm lint && pnpm typecheck && pnpm test
pnpm --filter @concord/desktop dist   # instalador NSIS local em apps/desktop/release
```

O `infra/.env.example` documenta todas as variáveis. Para testar sem a interface, o app aceita
em desenvolvimento `--user-data-dir=<pasta>` (duas instâncias lado a lado), `--server=<url>`,
`--key=<chave>` e `--room=<sala>`.

### Hospedar num PC Windows (alternativa à Oracle)

`infra/local/start.ps1` sobe o LiveKit e o api nativamente no Windows, sem Docker. O guia, com
port forwarding, DuckDNS, CGNAT e conta de upload, está em
[infra/local/README-local.md](infra/local/README-local.md).

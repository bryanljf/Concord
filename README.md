# Concord

Compartilhamento de tela para um grupo fechado de amigos, feito para conviver com o Discord: a voz
e o chat continuam lá; o Concord transmite a tela (com o som do jogo) por um servidor
[LiveKit](https://livekit.io) próprio, sem VPN.

- **App desktop** (Windows 10/11, Electron): fica na bandeja e abre uma janela com visual
  inspirado no Discord para assistir ou transmitir.
- **Servidor** (`concord-api` + `livekit-server` + `jam-bot` + Caddy): roda numa VM **Oracle
  Cloud Always Free**, atrás de um domínio com HTTPS (DuckDNS + Let's Encrypt).

Como instalar e usar (guia para os amigos): [docs/INSTALAR.md](docs/INSTALAR.md). Último
instalador: [releases/latest](https://github.com/bryanljf/Concord/releases/latest).

## Funcionalidades

- **Login com Discord** (OAuth2, escopo `identify`) restrito a uma lista de IDs autorizados.
  Nome e foto vêm do Discord e são atualizados sozinhos; cada um pode definir um apelido.
- **Salas** fixas (Sala 1, 2 e 3) com presença em tempo real: quem está em cada sala e quem
  está **AO VIVO**, mesmo para quem está fora da sala. A barra lateral recolhe numa coluna de
  ícones (o logo do Concord no topo): ponto verde se há gente (quem está aparece ao passar o
  mouse), ponto vermelho piscando se há live. Enquanto uma Jam toca, a sala mostra um fone com
  barrinhas animadas (na linha da sala e no ícone recolhido).
- **Transmitir** uma janela ou uma tela inteira na resolução (480p, 720p, 1080p ou 1440p) e nos
  quadros por segundo (15, 30 ou 60) que a pessoa escolher, H.264 com simulcast (teto de 0,8 a
  9,5 Mbps conforme a combinação); em todas, quando falta CPU a resolução cai antes da taxa de
  quadros. **Codificação** na CPU (padrão, OpenH264) ou na **GPU**: o LiveKit negocia H.264
  Constrained Baseline, que o encoder de hardware do Chromium no Windows não aceita; no modo GPU o
  app oferece primeiro High/Main (o servidor aceita High) e a placa codifica, sem placa compatível
  fica a CPU. O processo principal (onde o Chromium captura a tela) roda com **prioridade de GPU
  em tempo real** (`D3DKMTSetProcessSchedulingPriorityClass`, a mesma chamada do OBS, via
  `koffi`): com um jogo em primeiro plano ocupando a GPU, a captura caía para 8 a 24 fps e volta
  a 30, sem perda de fps mensurável no jogo (CS2 medido com PresentMon);
  `CONCORD_GPU_PRIORITY=normal` desliga.
  **Áudio por processo**: só o som do aplicativo, sem a call do Discord
  (WASAPI Process Loopback). **Trocar fonte** durante a live sem derrubar quem assiste.
- **Webcam** com escolha de dispositivo (botão **Câmera** na barra de baixo e Configurações →
  Câmera), publicada à parte da tela: quem assiste escolhe ver a tela, a câmera ou as duas.
- **Assistir sob demanda**: ao entrar numa sala nada é baixado; cada live e cada câmera aparece
  como cartão com **Assistir**. Com duas ou mais assistidas, elas ficam numa **grade** de duas
  colunas; só tem som a última escolhida (Assistir ou destaque), as outras começam mudas e o
  volume de cada uma aparece ao passar o mouse; a vaga ímpar oferece **Transmitir**. Clique num bloco para o **destaque** (qualidade cheia e áudio, as outras em
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
- **Jam**, a música do Concord: uma fila de músicas do YouTube Music por sala, sem anúncios. Na
  sala, qualquer um busca (o concord-api consulta o YouTube Music; também vale colar um link do
  YouTube) e adiciona músicas, até 50 na fila e de até 20 min cada. O app de quem pediu baixa o
  áudio com o [yt-dlp](https://github.com/yt-dlp/yt-dlp), anônimo (sem conta nem cookies) e pela
  própria conexão, porque o YouTube bloqueia downloads vindos do IP da VM (a busca funciona de
  lá), e o envia ao servidor **enquanto baixa**: com ~128 KB recebidos (~8 s de áudio) o bot já
  começa a tocar, então a música começa em poucos segundos. Para ficar quase instantâneo, o app
  adianta em memória o primeiro resultado da busca e os resultados sob o mouse (no máximo 3,
  descartados depois de 3 min; alguns MB de download por música adiantada); músicas que o
  servidor já tem (tocadas nas últimas 3 h) começam na hora, e o bot entra na sala assim que uma
  música entra na fila. O yt-dlp (a versão não empacotada para Windows, uma pasta de ~31 MB nos
  dados do app, conferida pelo SHA-256 publicado) é baixado no primeiro uso e sai depois de 30 dias
  sem usar a Jam; ele usa o cliente `visionos` do YouTube (sem a espera de 5 s do anúncio que os
  outros clientes impõem), os primeiros bytes chegam em ~1,4 s e o app não guarda cache dele. O **`jam-bot`** (Go) toca a fila de
  cada sala no LiveKit como uma faixa estéreo (`concord:music:jam`, participante `@jam`),
  repassando o Opus original sem recodificar: sem player do YouTube, não há anúncio. Quem ouve
  abre o painel de música pelo fone na linha da sala, clica em **Ouvir** e ajusta o próprio
  volume; quem está ouvindo aparece em avatares empilhados, como os espectadores de uma live;
  qualquer um na sala pausa e retoma para todos, pula ou remove músicas. Um som avisa quando uma
  Jam começa na sua sala (desligável em Configurações → Sons). As filas sobrevivem a um reinício
  do api; o áudio fica num cache no servidor (até 512 MB, e músicas fora da fila e não tocadas há
  3 h saem).
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
  (notificação, item na bandeja, faixa "Reiniciar agora" e uma seta verde ao lado de "CONCORD"
  na barra lateral expandida, que reinicia para instalar).

## Arquitetura

```
PC de cada amigo (Windows)                 VM Oracle (Ubuntu 24.04 ARM, Docker)
┌──────────────────────────────┐   HTTPS   ┌─────────────────────────────────────────────┐
│ Concord (Electron)           │──────────▶│ Caddy :443 (Let's Encrypt)                  │
│  main: bandeja, presença SSE,│           │  ├─ /api/*  → concord-api 127.0.0.1:3000    │
│        login Discord, update,│   WSS     │  └─ resto   → livekit-server :7880 (WSS)    │
│        yt-dlp (Jam)          │──────────▶│ livekit-server: mídia UDP 50000-50200,      │
│  renderer: React + livekit-  │ UDP/TCP   │                 TCP 7881; webhooks → api    │
│        client                │──────────▶│ concord-api: OAuth Discord, tokens LiveKit, │
└──────────────────────────────┘           │  presença (SSE), perfis, sync via bot, Jam  │
       ▲                                   │  (busca no YouTube Music, filas, cache)     │
       │ yt-dlp baixa o áudio da Jam:      │ jam-bot 127.0.0.1:3001 (Go): toca a Jam de  │
       │ anônimo, da conexão de cada um    │  cada sala no LiveKit, Opus sem recodificar │
    YouTube                                └─────────────────────────────────────────────┘
```

- `apps/desktop`: Electron 44 + electron-vite + React 19. `src/main` (processo principal; baixa
  o áudio da Jam com o yt-dlp, obtido no primeiro uso, e o envia enquanto baixa), `src/preload`
  (ponte IPC, contrato em `api.d.ts`), `src/renderer` (UI).
- `apps/api`: Fastify 5. Autenticação, tokens LiveKit restritos a compartilhamento de tela,
  presença por SSE alimentada por webhooks do LiveKit (com ressincronização a cada 60 s),
  perfis do Discord persistidos e apelidos. Na Jam, busca no YouTube Music, guarda as filas
  (`JAM_STATE_FILE`), recebe o áudio dos apps em streaming no cache (`JAM_CACHE_DIR`, até
  `JAM_CACHE_MAX_MB` e `JAM_CACHE_TTL_HOURS`) e comanda o jam-bot.
- `apps/jam-bot`: Go, imagem distroless (~23 MB). Toca a Jam de cada sala no LiveKit como uma
  faixa Opus estéreo, sem recodificar, a partir do arquivo ainda chegando. Só obedece ao api, por
  uma API interna em `127.0.0.1:3001` ([API.md](apps/jam-bot/API.md)); lê o cache que o api
  grava, nunca fala com o YouTube e não tem o segredo do LiveKit (o api lhe entrega os tokens).
- `packages/shared`: tipos e constantes comuns. `packages/process-audio`: adaptador do addon
  `loopback-capture` (áudio por processo, binário pré-compilado win32-x64).
- `infra/`: Terraform da VM (`infra/terraform`), `docker-compose.yml`, `Caddyfile`,
  `livekit.yaml` e o modo alternativo de hospedagem num PC Windows (`infra/local`).

## Operação

Passo a passo completo do servidor: [infra/README-deploy.md](infra/README-deploy.md).

| Tarefa                     | Como                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Liberar um amigo           | `pnpm --filter @concord/api user:add <id> <nome> --discord-id <ID do Discord>` no PC, copiar `infra/users.json` para `~/concord/infra/users.json` na VM e `docker compose -f infra/docker-compose.yml restart api`.                                                                                                                                                                                                     |
| Mudar as salas             | `ROOMS=sala-1,sala-2,sala-3` em `~/concord/infra/.env` na VM e `docker compose -f infra/docker-compose.yml up -d api`. O app mostra `sala-1` como "Sala 1".                                                                                                                                                                                                                                                             |
| Atualizar o servidor       | Push em `main`: o workflow **CI** roda e, se passar, o **Deploy Oracle** entra na VM por SSH e executa `infra/scripts/deploy-oracle.sh`. Commits com `[skip ci]` não disparam nada. A VM não compila o `jam-bot`: o Deploy Oracle compila o binário linux/arm64 no GitHub e o envia por SSH, e a VM só monta uma imagem de ~23 MB.                                                                                      |
| Jam                        | Ligada pelo compose (serviço `jam-bot`). `JAM_BOT_TOKEN` (opcional) no `~/concord/infra/.env` da VM chega ao api e ao bot (depois de mudá-lo, `up -d` sem nome de serviço, para recriar os dois). Áudio no volume `concord_jam-cache` (cache, até `JAM_CACHE_MAX_MB`, padrão 512; músicas fora da fila e não tocadas há `JAM_CACHE_TTL_HOURS` horas, padrão 3, saem; `0` desliga o prazo), filas no `concord_api-data`. |
| Publicar uma versão do app | Subir `version` em `apps/desktop/package.json`, criar e enviar a tag `vX.Y.Z` (igual à versão). O workflow **Release** gera `Concord-Setup-X.Y.Z.exe` e `latest.yml`, e os apps instalados atualizam sozinhos.                                                                                                                                                                                                          |
| Logs e consumo             | `ssh ubuntu@<IP da VM>` (o IP sai do `terraform output`), depois `cd ~/concord && docker compose -f infra/docker-compose.yml logs -f` (ou `logs -f jam-bot`, só a Jam) e `docker stats`.                                                                                                                                                                                                                                |
| Armazenamento              | Nada cresce sem limite: logs dos containers com rotação (3 × 10 MB por serviço), o deploy apaga imagens sem tag e cache de build com mais de uma semana, e o api limita o áudio da Jam (`JAM_CACHE_MAX_MB`, padrão 512; fora da fila e não tocadas há 3 h saem, conferido a cada 10 min). Conferir com `docker system df`; detalhes na seção 8.1 do [README-deploy](infra/README-deploy.md).                            |
| Infraestrutura             | `infra/terraform` (state e `terraform.tfvars` só no PC do administrador, fora do Git). A VM ignora mudanças de imagem e de cloud-init, então um `terraform apply` comum nunca a recria.                                                                                                                                                                                                                                 |

Segredos ficam só na VM (`~/concord/infra/.env`: segredo do LiveKit, client secret e bot token
do Discord, segredo de sessão e, opcional, o `JAM_BOT_TOKEN` entre o api e o jam-bot) e em
`infra/users.json`; nada disso vai para o Git. O jam-bot não recebe o `.env`: só o token dele. No GitHub, o
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

Jam: o `jam-bot`, medido na mesma VM, gasta ~0,75% de um núcleo por sala tocando (~1,9% com 3
salas, ~0,2% em pausa) e ~50 MB de RAM (RSS), enviando em estéreo o Opus original do YouTube
(~130 kbps), sem decodificar. O compose o limita a 0,25 CPU e 128 MB.

## Desenvolvimento

Requisitos: Node 22+ e pnpm 12; para a Jam, também Go (a versão do `apps/jam-bot/go.mod`).
Convenções do código em [CLAUDE.md](CLAUDE.md).

```bash
pnpm install
pnpm dev:livekit   # livekit-server local (binário oficial em infra/local/bin)
pnpm dev:api       # concord-api em http://127.0.0.1:3000 (lê infra/.env)
pnpm dev:jam-bot   # jam-bot em 127.0.0.1:3001 (Go); o api só liga a Jam com JAM_BOT_URL no infra/.env
pnpm dev           # app desktop com hot reload
pnpm lint && pnpm typecheck && pnpm test
pnpm --filter @concord/desktop dist   # instalador NSIS local em apps/desktop/release
```

O `pnpm dev:jam-bot` (`go run`) não precisa de mais nada. Já a imagem Docker do jam-bot não
compila Go: ela só copia `apps/jam-bot/dist/jam-bot-linux-<arquitetura>` (fora do git; na VM,
quem o envia é o deploy). Para um `docker compose ... build` local, gere antes o binário da
arquitetura da máquina (PC x86-64 = `amd64`):

```bash
cd apps/jam-bot
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o dist/jam-bot-linux-amd64 .
```

O `infra/.env.example` documenta todas as variáveis. Para testar sem a interface, o app aceita
em desenvolvimento `--user-data-dir=<pasta>` (duas instâncias lado a lado), `--server=<url>`,
`--key=<chave>` e `--room=<sala>`; `--fake-update=<versão>` simula uma atualização (Configurações
→ Sobre → Verificar atualizações) para testar a faixa, a seta e o Sobre sem publicar nada.

### Hospedar num PC Windows (alternativa à Oracle)

`infra/local/start.ps1` sobe o LiveKit e o api nativamente no Windows, sem Docker (a Jam é
opcional e pede o bot à parte, `pnpm dev:jam-bot`). O guia, com
port forwarding, DuckDNS, CGNAT e conta de upload, está em
[infra/local/README-local.md](infra/local/README-local.md).

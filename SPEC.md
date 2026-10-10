# SPEC — "Concord": compartilhamento de tela companion do Discord

> Documento de especificação para execução com o **Claude Code**.
> Claude: leia este arquivo inteiro antes de começar. Execute **uma fase por vez** (seção 9), pare no fim de cada fase, mostre o que foi feito e como testar, e só avance quando o usuário confirmar.

---

## 1. Contexto e objetivo

Um grupo de ~10 amigos na mesma cidade (Brasil) usa o Discord para voz e chat, mas o **Go Live (compartilhamento de tela) do Discord está bloqueado/instável para usuários brasileiros**. Em vez de usar VPN, vamos criar um **app companion próprio** só para transmissão de tela:

- O Discord continua sendo usado para **voz e texto**.
- O **Concord** (nome provisório) roda **na bandeja do Windows**, inicia junto com o sistema (oculto), avisa quando alguém começa a transmitir e abre uma janela **com visual inspirado no Discord** para assistir/transmitir.
- A mídia passa por um **servidor LiveKit (SFU WebRTC) self-hosted** em uma VM **Oracle Cloud Always Free** (ARM Ampere A1) que já existe e **roda também um servidor de Minecraft** — o Concord precisa conviver com ele sem atrapalhar.

### Objetivos
- Transmissão de tela/janela com **áudio do app** (som do jogo), até 1080p60, latência baixa (< 300 ms ponta a ponta na mesma cidade).
- Até **10 pessoas** simultâneas, até **3 transmissões** simultâneas por sala.
- Experiência "zero atrito": instala, digita apelido + chave de acesso uma vez, e esquece na bandeja.
- **Custo zero**: tudo dentro dos limites Always Free da Oracle.

### Não-objetivos (por enquanto)
- Chat de voz/texto (isso continua no Discord).
- Câmera/webcam.
- macOS. (Linux é desejável mas secundário — ver seção 12.)
- Gravação de transmissões.
- Usar logos, ícones ou assets do Discord (proibido — só inspirar o layout/estilo).

---

## 2. Arquitetura

```
┌───────────────────────────── PC de cada amigo (Windows) ─────────────────────────────┐
│  Discord (voz/chat)                                                                  │
│                                                                                      │
│  Concord (Electron)                                                                    │
│   ├─ main process: bandeja, autostart, atalho global, captura de tela/áudio,         │
│   │                watcher do processo Discord, auto-update                          │
│   ├─ preload: ponte IPC tipada (contextIsolation)                                    │
│   └─ renderer (React): UI estilo Discord, livekit-client                             │
└──────────────┬──────────────────────────────────────┬────────────────────────────────┘
               │ HTTPS (token, presença SSE)          │ WebRTC (WSS sinalização + UDP mídia)
               ▼                                      ▼
┌──────────────────────────── VM Oracle Always Free (Ubuntu ARM64) ────────────────────┐
│  Caddy (HTTPS automático, Let's Encrypt)                                             │
│   ├─ https://<dominio>/api/*   → concord-api  (Fastify, Node 22)                       │
│   └─ wss://<dominio>/rtc       → livekit-server                                      │
│  livekit-server (network_mode: host)  ── webhooks ──► concord-api                      │
│  concord-api: emite tokens LiveKit, valida chaves de usuário, expõe presença via SSE   │
│  [já existente] servidor Minecraft (porta 25565) — NÃO MEXER                         │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

### Decisões
| Tema | Escolha | Motivo |
|---|---|---|
| SFU | **LiveKit** (open source, self-hosted) | SDKs maduros, simulcast/dynacast, componentes React prontos, roda em ARM64 |
| Desktop | **Electron** + **electron-vite** + React + TypeScript | `desktopCapturer` + `setDisplayMediaRequestHandler`; captura de áudio no Windows; ecossistema de auto-update |
| Backend | **Fastify** + `livekit-server-sdk` | Leve (< 100 MB RAM) |
| Proxy/TLS | **Caddy** | HTTPS automático, config mínima |
| Domínio | **DuckDNS** (grátis) ou domínio próprio | WebRTC/secure context exige HTTPS |
| Monorepo | **pnpm workspaces** | Compartilhar tipos entre app e api |
| Empacotamento | **electron-builder** (NSIS) + **electron-updater** via GitHub Releases | Instalador `.exe` + atualização automática |
| Hospedagem | **Oracle (Docker + Caddy)** _ou_ **PC local (Windows nativo, seção 4.7)** | Mesmo `api` e `livekit.yaml`; só muda o `.env` |

---

## 3. Estrutura do repositório

```
concord/
├─ SPEC.md                    ← este arquivo
├─ CLAUDE.md                  ← gerar na Fase 0 (resumo curto: comandos, convenções)
├─ package.json               ← scripts raiz (dev, build, lint, test, typecheck)
├─ pnpm-workspace.yaml
├─ .editorconfig / .gitignore / .nvmrc (22)
├─ packages/
│  └─ shared/                 ← tipos e constantes (rooms, eventos de presença, DTOs da API)
├─ apps/
│  ├─ api/                    ← concord-api (Fastify)
│  │  ├─ src/
│  │  │  ├─ index.ts
│  │  │  ├─ routes/token.ts
│  │  │  ├─ routes/presence.ts      ← SSE
│  │  │  ├─ routes/livekit-webhook.ts
│  │  │  ├─ auth.ts                 ← validação de chaves (users.json)
│  │  │  └─ presence-store.ts
│  │  ├─ test/
│  │  └─ Dockerfile
│  └─ desktop/                ← Concord (Electron)
│     ├─ electron.vite.config.ts
│     ├─ electron-builder.yml
│     ├─ resources/           ← ícones próprios (bandeja: normal / ao vivo / desconectado)
│     ├─ src/main/
│     │  ├─ index.ts
│     │  ├─ tray.ts
│     │  ├─ autostart.ts
│     │  ├─ shortcuts.ts
│     │  ├─ capture.ts          ← setDisplayMediaRequestHandler + escolha de fonte
│     │  ├─ audio/              ← captura de áudio por processo (Fase 3b)
│     │  ├─ discord-watcher.ts
│     │  ├─ updater.ts
│     │  └─ settings.ts         ← electron-store
│     ├─ src/preload/index.ts
│     └─ src/renderer/
│        ├─ main.tsx
│        ├─ theme.css           ← tokens de cor estilo Discord
│        ├─ components/         ← Sidebar, RoomList, ParticipantRow, Stage, StreamTile,
│        │                        SourcePicker, Settings, Onboarding
│        ├─ hooks/              ← useRoom, usePresence, useSettings
│        └─ lib/api.ts
└─ infra/
   ├─ docker-compose.yml
   ├─ livekit.yaml
   ├─ Caddyfile
   ├─ users.example.json
   ├─ .env.example
   ├─ README-deploy.md        ← passo a passo Oracle (seção 8)
   └─ local/                  ← hospedagem no PC (seção 4.7)
      ├─ start.ps1
      └─ README-local.md
```

---

## 4. Servidor (`apps/api` + `infra/`)

### 4.1 Autenticação (simples e suficiente para um grupo fechado)
- `infra/users.json` (fora do git; só `users.example.json` versionado):
  ```json
  { "users": [ { "id": "bryan", "displayName": "Bryan", "key": "<32+ chars aleatórios>", "admin": true } ] }
  ```
- Script `pnpm --filter api user:add <id> <displayName>` gera chave aleatória (crypto.randomBytes(24).toString('base64url')), grava no JSON e imprime a chave para enviar ao amigo.
- Cliente envia `Authorization: Bearer <key>`. Comparação com `crypto.timingSafeEqual`.
- Rate limit (`@fastify/rate-limit`): 30 req/min por IP em `/api/token`.

### 4.2 Endpoints
| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/api/health` | `{ ok: true }` |
| `GET` | `/api/me` | Retorna usuário da chave (valida login no onboarding) |
| `GET` | `/api/rooms` | Lista salas configuradas (`ROOMS` no `.env`, ex.: `geral,jogos,filme`) |
| `POST` | `/api/token` | Body `{ room }` → `{ token, url }`. JWT LiveKit com `identity = user.id`, `name = displayName`, grants: `roomJoin`, `canSubscribe`, `canPublish` (só fontes `screen_share` e `screen_share_audio`), `canPublishData`. TTL 6 h |
| `GET` | `/api/presence` | **SSE**. Envia snapshot inicial e depois eventos: `participant_joined`, `participant_left`, `stream_started`, `stream_stopped` (por sala). Heartbeat a cada 25 s |
| `POST` | `/api/livekit/webhook` | Recebe webhooks do LiveKit (validar com `WebhookReceiver` do SDK) e alimenta o presence-store |

- No boot, o presence-store faz um **resync** via `RoomServiceClient.listRooms/listParticipants` (o servidor pode ter reiniciado com gente conectada).
- Presença vive em memória (sem banco).

### 4.3 LiveKit (`infra/livekit.yaml`)
- `port: 7880` (sinalização, atrás do Caddy)
- `rtc.tcp_port: 7881`
- `rtc.port_range_start: 50000`, `rtc.port_range_end: 50200` (faixa pequena = menos regras de firewall)
- `rtc.use_external_ip: true`, mais `rtc.skip_external_ip_validation: true` e `rtc.advertise_internal_ip: true` (verificado com o binário: atrás de roteador doméstico o auto-teste do IP público falha e o LiveKit passaria a anunciar só o IP da LAN; inofensivo na Oracle)
- `room.max_participants: 15`, `room.empty_timeout: 300`
- `webhook.urls: [ "http://127.0.0.1:3000/api/livekit/webhook" ]`, `webhook.api_key` = a mesma API key
- `keys:` vindas do `.env` (`LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`, gerar aleatórias)
- TURN embutido **desligado** no MVP (todos têm internet residencial normal). Deixar comentado como habilitar TURN/TLS caso alguém fique em rede restritiva.

### 4.4 `infra/docker-compose.yml`
- `livekit`: imagem oficial `livekit/livekit-server` (multi-arch, roda em ARM64), `network_mode: host`, `restart: unless-stopped`, **limites**: `cpus: "1.0"`, `mem_limit: 1g`.
- `api`: build de `apps/api`, porta `127.0.0.1:3000`, `cpus: "0.25"`, `mem_limit: 256m`, monta `users.json` read-only.
- `caddy`: `caddy:2`, portas `80` e `443`, volume para certificados, `cpus: "0.25"`, `mem_limit: 128m`.
- **Nunca** tocar no container/serviço do Minecraft nem na porta 25565.

### 4.5 `infra/Caddyfile`
```
{$DOMAIN} {
  handle /api/* { reverse_proxy 127.0.0.1:3000 }
  handle        { reverse_proxy 127.0.0.1:7880 }   # WSS do LiveKit
}
```

### 4.6 Testes do api
- Vitest: auth (chave válida/inválida/ausente), geração de token (grants corretos, identity), presence-store (sequências de eventos), validação de webhook.
- Para dev local: `infra/local/start.ps1 -LiveKitOnly` (binário oficial no Windows) ou `infra/docker-compose.dev.yml` + `pnpm dev:api`.

### 4.7 Hospedagem local (no PC de alguém do grupo, sem Oracle)

Alternativa à VM: o mesmo `concord-api` + `livekit-server` rodam **nativamente no Windows** de quem hospeda (sem Docker, sem Caddy, sem TLS — o app Electron aceita `http://` e `ws://`).

- `infra/local/start.ps1` baixa o binário oficial do LiveKit (versão fixa + verificação de checksum), carrega `infra/.env`, sobe os dois processos e imprime a URL que os amigos digitam no app (`http://<ip-publico-ou-ddns>:3000`). Switches: `-LiveKitOnly`, `-Stop`, `-Firewall`.
- A API key do LiveKit é o identificador fixo `concord`; só o segredo é aleatório (`LIVEKIT_API_SECRET`). Assim `infra/livekit.yaml` é idêntico nos dois modos e o segredo entra por `LIVEKIT_KEYS`.
- `LIVEKIT_LOCAL_URL` (ex.: `ws://127.0.0.1:7880`): devolvido pelo `/api/token` quando a requisição vem de loopback, para quem hospeda não depender de NAT hairpinning do roteador.
- Roteador: encaminhar TCP 3000, 7880, 7881 e UDP 50000–50200; DuckDNS opcional para IP dinâmico.
- Riscos específicos: **CGNAT** (sem IPv4 público → não funciona sem IPv6/túnel), **upload residencial** (o SFU envia uma cópia por espectador: 6 Mbps × 9 espectadores ≈ 54 Mbps), o PC precisa ficar ligado.
- Guia completo em pt-BR: `infra/local/README-local.md`.

---

## 5. App desktop (`apps/desktop`)

### 5.1 Segurança do Electron (obrigatório)
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` no renderer.
- Preload expõe API mínima e tipada via `contextBridge` (`window.concord.*`).
- CSP restrita (só o próprio bundle + `https://<dominio>` + `wss://<dominio>`).
- `app.requestSingleInstanceLock()` — segunda instância só foca a janela existente.
- Chave do usuário guardada com `safeStorage` (DPAPI no Windows), não em texto puro.

### 5.2 Ciclo de vida, bandeja e autostart
- Ícone na bandeja com 3 estados: **conectado**, **alguém ao vivo** (badge vermelho), **desconectado/erro**.
- Menu da bandeja: `Abrir Concord`, `Transmitir…` (abre o seletor), `Parar transmissão` (se ativo), `Iniciar com o Windows ✓`, `Abrir junto com o Discord ✓`, `Configurações`, `Sair`.
- Fechar a janela (X) **esconde** para a bandeja (não sai). Primeira vez: notificação explicando isso.
- **Autostart**: `app.setLoginItemSettings({ openAtLogin, args: ['--hidden'] })`. Com `--hidden`, não mostrar janela.
- **Modo "junto com o Discord"** (`discord-watcher.ts`): a cada 10 s verifica se existe processo `Discord.exe` (ou `DiscordPTB.exe`/`DiscordCanary.exe`). Se o Discord abrir → conecta à presença; se o Discord fechar e não houver transmissão ativa → desconecta e fica ocioso. Implementar com `tasklist /FO CSV /NH` (sem dependência nativa) e abstrair para facilitar Linux depois.

### 5.3 Onboarding (primeira execução)
1. Campo **URL do servidor** (pré-preenchido via variável de build `VITE_DEFAULT_SERVER`).
2. Campo **chave de acesso** → chama `/api/me` → mostra "Olá, Bryan!".
3. Preferências: iniciar com Windows (padrão: sim), abrir com o Discord (padrão: sim), atalho (padrão `Ctrl+Shift+L`).

### 5.4 Presença e notificações
- Com o app em segundo plano, manter **apenas** a conexão SSE `/api/presence` (zero mídia, quase zero banda).
- Quando chegar `stream_started` de outra pessoa: **notificação nativa** "🔴 Fulano está ao vivo em #jogos — clique para assistir". Clique → abre a janela, entra na sala e foca a stream.
- Configuração: silenciar notificações por sala / por pessoa.
- Reconexão SSE com backoff exponencial (1 s → 30 s).

### 5.5 UI estilo Discord (renderer)
Layout de referência (cores/estrutura inspiradas, **sem assets do Discord**):
```
┌──────────┬───────────────────────────────────────────────┐
│ CONCORD    │  #jogos                          [⛶] [⇱] [⚙] │
│          ├───────────────────────────────────────────────┤
│ SALAS    │                                               │
│ 🔊 geral │            STREAM EM DESTAQUE                 │
│ 🔊 jogos │            (palco / "stage")                  │
│  ├ Ana 🔴│                                               │
│  └ Beto  │                                               │
│ 🔊 filme ├───────────────────────────────────────────────┤
│          │  [mini tile] [mini tile] [mini tile]          │
├──────────┤                                               │
│ 🟢 Bryan │  [🖥 Transmitir]  [⏹ Parar]  qualidade: 1080p60│
└──────────┴───────────────────────────────────────────────┘
```
- **Sidebar**: lista de salas; dentro de cada uma, participantes conectados (vindos da presença), com badge **AO VIVO** vermelho em quem transmite. Clicar na sala = entrar; clicar no badge = entrar e assistir aquela stream.
- **Stage**: stream em destaque; abaixo, tiles das outras streams da sala. Clicar num tile troca o destaque.
- Controles por stream: **volume** individual (0–200%), **mudo**, **tela cheia** (F11/duplo clique), **pop-out** em janela separada (BrowserWindow sem moldura, sempre no topo opcional).
- Entrar numa sala **não** assina vídeo automaticamente: só assina a stream que o usuário escolher assistir (`autoSubscribe: false`, assinatura manual). Mini-tiles usam a camada de baixa resolução do simulcast.
- `theme.css` com tokens (ex.: `--bg-primary: #313338`, `--bg-secondary: #2b2d31`, `--bg-tertiary: #1e1f22`, `--text-normal: #dbdee1`, `--accent: #5865f2`, `--live: #da373c`), fonte "gg sans" **não** — usar `Inter`/`Noto Sans` (licença livre).
- Usar `@livekit/components-react` onde ajudar (VideoTrack, hooks de room), mas a UI visual é nossa.

### 5.6 Transmissão (captura de tela)
- Botão **Transmitir** ou atalho global → abre **SourcePicker** próprio (modal estilo Discord) com abas **Aplicativos** (janelas) e **Telas**, miniaturas via `desktopCapturer.getSources({ types: ['window','screen'], thumbnailSize, fetchWindowIcons: true })`, atualizadas a cada 2 s.
- Renderer envia `sourceId` escolhido via IPC → main guarda → renderer chama `getDisplayMedia` → `session.setDisplayMediaRequestHandler` responde com a fonte escolhida.
- **Presets de qualidade** (seletor no picker):
  | Preset | Resolução | FPS | Bitrate máx. |
  |---|---|---|---|
  | Leve | 720p | 30 | 2,5 Mbps |
  | Padrão | 1080p | 30 | 4 Mbps |
  | Jogo | 1080p | 60 | 6 Mbps |
- `contentHint = 'motion'` no preset Jogo, `'detail'` nos outros. Publicar com simulcast (2 camadas) e `dynacast: true`, `adaptiveStream: true` no room.
- Codec: começar com **H.264** (melhor suporte a encoder de hardware); deixar VP9/AV1 como opção avançada nas configurações.
- Indicador claro de "você está ao vivo" (ícone da bandeja + borda vermelha + botão Parar). Se a janela capturada fechar, parar a transmissão automaticamente.

### 5.7 Áudio da transmissão — ⚠️ ponto crítico
**Problema**: capturar o áudio do sistema inteiro (`audio: 'loopback'` do Electron) inclui **o áudio da call do Discord** → quem assiste ouve a própria voz com atraso (eco). O Discord resolve isso capturando áudio **por processo**.

- **Fase 3a (MVP)**: `audio: 'loopback'` com opção "Incluir áudio do sistema" **desligada por padrão** e um aviso: "use fone de ouvido ou o áudio da call vai junto".
- **Fase 3b (correto)**: captura de áudio **por processo** usando a API do Windows 10 2004+ **Process Loopback** (`ActivateAudioInterfaceAsync` com `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`):
  - Compartilhando **janela** → modo `INCLUDE_TARGET_PROCESS_TREE` com o PID dono da janela (só o som do jogo/app).
  - Compartilhando **tela inteira** → modo `EXCLUDE_TARGET_PROCESS_TREE` com o PID do Discord (tudo menos a call).
  - Implementação: primeiro **pesquisar** pacotes npm/addons existentes para process loopback no Windows (avaliar manutenção, licença, suporte a ARM/x64, compatibilidade com a versão do Electron). Se nenhum servir, escrever um addon nativo pequeno (C++ com `node-addon-api`, prebuilds via `prebuildify`) que entrega PCM float32 48 kHz estéreo ao renderer.
  - No renderer, PCM → `AudioWorklet` → `MediaStreamTrack` publicado como `Track.Source.ScreenShareAudio`.
  - Descobrir PID da janela: o `sourceId` do `desktopCapturer` contém o HWND (`window:<hwnd>:0`) → `GetWindowThreadProcessId`.
- Quem assiste: áudio da stream com volume próprio, independente do Discord.

### 5.8 Configurações
Servidor/chave (trocar), iniciar com Windows, abrir com Discord, atalho global (gravador de tecla), qualidade padrão, codec, notificações (por sala/pessoa), dispositivo de saída de áudio das streams (`setSinkId`), "Verificar atualizações", "Sobre".

### 5.9 Auto-update e distribuição
- `electron-builder` alvo **NSIS** (`oneClick: true`, instalação por usuário, sem admin), nome `Concord-Setup-<versão>.exe`.
- `electron-updater` com provider **GitHub Releases** (repo privado ou público — perguntar ao usuário). Checa ao iniciar e a cada 6 h; baixa em segundo plano; aplica ao sair ou com botão "Reiniciar para atualizar".
- Sem certificado de assinatura de código: documentar no README que o **SmartScreen** vai avisar na primeira instalação ("Mais informações → Executar assim mesmo").
- GitHub Action `release.yml`: em tag `v*`, build Windows (`windows-latest`) e publica no Release.

### 5.10 Decisões de implementação registradas (Fase 2)

- **Presença vive no processo principal**: o `main` mantém a conexão SSE, o snapshot, a bandeja e as notificações; o renderer só recebe eventos por IPC. Funciona com a janela escondida e a chave nunca sai do `main`.
- **Chave e preferências**: arquivo `settings.json` em `userData` escrito atomicamente (sem `electron-store`, que é ESM-only); a chave fica em `encryptedKey` via `safeStorage` (DPAPI).
- **CSP**: `script-src 'self'` continua estrito, mas `connect-src` aceita `http: https: ws: wss:` porque a URL do servidor é configurável pelo usuário (hospedagem local em `http://`). Hosts específicos não podem ser fixados.
- **Flags de linha de comando**: `--hidden`, `--user-data-dir=<pasta>` (duas instâncias para teste) e, só fora do pacote, `--server=<url> --key=<chave> --room=<sala>` para login/entrada automáticos em testes.
- **Contrato main ↔ renderer**: `apps/desktop/src/preload/api.d.ts` (`window.concord`) é a única fronteira; mudanças passam por ali primeiro. Os handlers IPC devolvem um envelope `{ ok, value | message }` para que a mensagem pt-BR chegue limpa ao renderer.
- **Notificações no Windows**: o `main` registra o AppUserModelId `com.concord.desktop`; o `appId` do electron-builder (Fase 6) **tem** de ser o mesmo.

---

## 6. Tipos compartilhados (`packages/shared`)
```ts
export type RoomId = string;
export interface PresenceParticipant { id: string; name: string; streaming: boolean; joinedAt: number; }
export interface PresenceSnapshot { rooms: Record<RoomId, PresenceParticipant[]>; }
export type PresenceEvent =
  | { type: 'snapshot'; data: PresenceSnapshot }
  | { type: 'participant_joined' | 'participant_left'; room: RoomId; participant: PresenceParticipant }
  | { type: 'stream_started' | 'stream_stopped'; room: RoomId; participantId: string };
export interface TokenResponse { token: string; url: string; }
export const QUALITY_PRESETS = { /* conforme tabela 5.6 */ } as const;
```

---

## 7. Orçamento de recursos na VM (convivência com o Minecraft)
- Limite Always Free A1: **2 OCPU / 12 GB** somados por conta (confirmar no console — contas antigas podem ter mais).
- Concord total (livekit + api + caddy): **≤ 1,5 CPU e ≤ 1,4 GB RAM** pelos limites do compose.
- Tráfego: ~6 GB/h numa call típica (1 stream, 4–5 assistindo); pior caso ~50 GB/h. Limite grátis: **10 TB/mês** de saída.
- Antes do deploy, rodar `free -h`, `nproc`, `docker ps`/`systemctl` para ver o que o Minecraft usa e **mostrar ao usuário** antes de subir qualquer coisa.

---

## 8. Deploy na Oracle (`infra/README-deploy.md`)
Gerar um passo a passo detalhado contendo:
1. **Pré-checagem**: região home da conta (ideal: `sa-saopaulo-1` ou `sa-vinhedo-1`), shape e uso atual da VM, IP público.
2. **DNS**: criar subdomínio no DuckDNS apontando para o IP público (ou registro A no domínio próprio).
3. **Firewall – Security List da VCN** (Ingress): TCP 80, TCP 443, TCP 7881, UDP 50000–50200. Manter a regra existente do Minecraft (TCP 25565).
4. **Firewall – iptables da VM** (imagem Ubuntu da Oracle bloqueia por padrão):
   ```bash
   sudo iptables -I INPUT 6 -p tcp -m multiport --dports 80,443,7881 -j ACCEPT
   sudo iptables -I INPUT 6 -p udp --dport 50000:50200 -j ACCEPT
   sudo netfilter-persistent save
   ```
5. Instalar Docker + compose plugin (se ainda não houver), clonar o repo, `cp infra/.env.example infra/.env`, gerar segredos, criar `users.json`.
6. `docker compose -f infra/docker-compose.yml up -d` e validar: `curl https://<dominio>/api/health`, teste de conexão em https://livekit.io/connection-test (ou ferramenta equivalente) usando um token gerado.
7. **Verificar que o Minecraft continua funcionando** (conectar no servidor) — critério obrigatório.
8. Manutenção: logs (`docker compose logs -f`), atualizar (`git pull && docker compose up -d --build`), backup do `users.json`.
9. Nota sobre ociosidade: VMs Always Free podem ser recuperadas se ficarem 7 dias com CPU, rede e memória < 20%; contas Pay As You Go não sofrem isso.

---

## 9. Fases de execução

> Ao final de **cada** fase: rodar `pnpm lint`, `pnpm typecheck` e `pnpm test`; listar o que foi feito, como testar manualmente e pendências; **esperar confirmação** do usuário.

### Fase 0 — Fundação
- Monorepo pnpm, TypeScript strict, ESLint + Prettier, Vitest, `.nvmrc` (Node 22), scripts raiz.
- Scaffold `apps/desktop` com electron-vite (React + TS), `apps/api` (Fastify), `packages/shared`.
- Gerar `CLAUDE.md` curto (comandos, estrutura, convenções da seção 10).
- `git init` + primeiro commit (perguntar antes de criar repo remoto).
- **Pronto quando**: `pnpm dev` abre uma janela Electron "Olá Concord" e `pnpm --filter api dev` responde `/api/health`.

### Fase 1 — Servidor local
- Auth por chave, `/api/me`, `/api/rooms`, `/api/token`, script `user:add`.
- `infra/livekit.yaml` compartilhado, `infra/local/start.ps1` + `README-local.md` (hospedagem local no Windows, seção 4.7) e `infra/docker-compose.dev.yml` para quem prefere Docker.
- Webhook + presence-store + SSE `/api/presence` + resync no boot.
- Testes unitários do api.
- **Pronto quando**: com dois tokens, dá para entrar numa sala pelo LiveKit Meet de exemplo e o SSE mostra os eventos.

### Fase 2 — Desktop: base
- Segurança Electron (5.1), single instance, bandeja (5.2), fechar→bandeja, autostart com `--hidden`, discord-watcher.
- Onboarding (5.3) com `safeStorage`.
- Cliente SSE de presença + notificações nativas (5.4).
- Layout Discord-like estático com dados reais de presença (sidebar + palco vazio).
- **Pronto quando**: duas instâncias (dois usuários) veem um ao outro na sidebar ao entrar numa sala.

### Fase 3a — Transmitir e assistir
- SourcePicker, `setDisplayMediaRequestHandler`, presets de qualidade, publicação com simulcast.
- Assistir: assinatura manual, palco + tiles, volume por stream, tela cheia, pop-out.
- Áudio via loopback opcional (desligado por padrão + aviso).
- Atalho global para iniciar/parar.
- **Pronto quando**: usuário A transmite um jogo em 1080p60 e B assiste fluido na rede local/servidor dev; notificação aparece para B.

### Fase 3b — Áudio por processo
- Pesquisa de soluções existentes → proposta ao usuário → implementação (5.7).
- **Pronto quando**: transmitindo uma janela de jogo com a call do Discord ativa, quem assiste ouve o jogo e **não** ouve a call.

### Fase 4 — Polimento da UI
- Tema completo, animações sutis, estados vazios, erros de conexão amigáveis, indicador de qualidade de rede (`ConnectionQuality` do LiveKit), configurações (5.8), silenciar por sala/pessoa.

### Fase 5 — Deploy na Oracle (opcional se o grupo usar a hospedagem local da seção 4.7)
- Docker do api (multi-arch, `linux/arm64`), compose de produção, Caddyfile, `README-deploy.md` (seção 8).
- **Antes de qualquer comando na VM, mostrar o plano e pedir confirmação.** Nada de mexer no Minecraft.
- **Pronto quando**: amigos fora da rede local transmitem/assistem via domínio público e o Minecraft segue funcionando.

### Fase 6 — Distribuição
- electron-builder NSIS, ícones próprios, electron-updater, GitHub Action de release.
- README para os amigos: instalar, aviso do SmartScreen, onde colocar a chave.
- **Pronto quando**: publicar `v0.1.0` gera o `.exe`, e instalar `v0.1.1` por cima atualiza sozinho.

### Fase 7 (opcional) — Integração com o Discord
- **7a**: Discord RPC local para detectar o canal de voz atual e sugerir/entrar automaticamente na sala correspondente (mapeamento canal→sala nas configurações). Verificar antes se os escopos necessários estão disponíveis para um app pessoal (dono + testers); se não estiverem, reportar e não insistir.
- **7b**: plugin Vencord/Equicord que mostra botão "Transmitir no Concord" e o badge AO VIVO dentro do Discord, conversando com o app via `http://127.0.0.1:<porta>` local. **Avisar o usuário que client mods violam os Termos do Discord** e só fazer com confirmação explícita.

---

## 10. Convenções para o Claude Code
- Código, nomes e commits em **inglês**; textos da UI e documentação para o usuário em **português (pt-BR)**.
- TypeScript `strict`, sem `any` implícito. Funções pequenas, sem abstrações prematuras.
- Commits pequenos por funcionalidade (Conventional Commits). Não fazer push nem criar repo remoto sem pedir.
- **Nunca** commitar segredos: `.env`, `users.json`, chaves LiveKit. Manter `.env.example` / `users.example.json` atualizados.
- Fixar versões de dependências no lockfile; preferir versões estáveis atuais. Verificar na documentação oficial as APIs do LiveKit/Electron antes de usar (APIs mudam entre versões).
- Qualquer ação na VM de produção, publicação de release ou operação irreversível: **pedir confirmação**.
- Se algo desta spec se mostrar inviável ou pior que uma alternativa, **parar e propor** a mudança em vez de improvisar.

---

## 11. Critérios de aceite do MVP (fim da Fase 6)
- [ ] Instalação com um `.exe`, onboarding em < 1 minuto.
- [ ] App inicia com o Windows oculto na bandeja e usa < 150 MB RAM ocioso.
- [ ] Notificação em < 3 s quando um amigo começa a transmitir.
- [ ] 1080p60 fluido com 1 transmissor e 9 espectadores; 3 transmissões simultâneas na mesma sala funcionam.
- [ ] Latência percebida baixa (movimento do mouse do transmissor visível em < 300 ms).
- [ ] Áudio do jogo sem eco da call do Discord (Fase 3b).
- [ ] Volume, tela cheia e pop-out por stream.
- [ ] Atualização automática funcionando.
- [ ] Servidor dentro dos limites de CPU/RAM definidos; Minecraft intacto.

## 12. Riscos e pendências
| Risco | Mitigação |
|---|---|
| CPU da VM ARM insuficiente com Minecraft + LiveKit em pico | Limites no compose; SFU não transcodifica (custo baixo); monitorar com `docker stats` |
| Alguém atrás de rede que bloqueia UDP | Fallback TCP 7881 já incluso; habilitar TURN/TLS se necessário |
| Captura por processo não suportada (Windows < 10 2004) | Cair para loopback com aviso |
| SmartScreen assusta os amigos | README com prints; opcional futuro: assinatura de código |
| Oracle recuperar VM ociosa | Conta do amigo em Pay As You Go, ou uso regular |
| Linux (algum amigo) | Electron funciona; captura via PipeWire; áudio por processo fica para depois |

## 13. Perguntas em aberto (perguntar ao usuário quando chegar a hora)

> **Respondidas em 2026-10-10**: (1) nome final **Concord**, ícone mantido; (2) hospedagem **só no PC do usuário** por enquanto (seção 4.7), sem DuckDNS; a Fase 5 (Oracle) fica apenas **preparada** (arquivos em `infra/`), sem deploy; (3) sem Oracle por ora; (4) repositório GitHub **público**; (5) todos usam **Windows 11**; (6) salas: `geral` por padrão (ajustável em `ROOMS`).
1. Nome final do app e ícone.
2. Domínio: DuckDNS ou próprio? Qual subdomínio?
3. Região home da conta Oracle do amigo e quanto de CPU/RAM o Minecraft usa.
4. Repositório GitHub público ou privado (afeta o auto-update — repo privado exige token).
5. Algum amigo usa Linux/macOS?
6. Lista inicial de salas.

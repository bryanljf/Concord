# Concord

Compartilhamento de tela para um grupo fechado de amigos, feito para conviver com o Discord: a voz
e o chat continuam lá; o Concord transmite a tela (com o som do jogo) por um servidor
[LiveKit](https://livekit.io) próprio, sem VPN.

- **App desktop** (Windows 10/11, Electron): fica na bandeja e abre uma janela com visual
  inspirado no Discord para assistir ou transmitir.
- **Servidor** (`concord-api` + `livekit-server` + Caddy): roda numa VM **Oracle Cloud Always
  Free** em `https://exemplo.duckdns.org`.

Como instalar e usar (guia para os amigos): [docs/INSTALAR.md](docs/INSTALAR.md). Último
instalador: [releases/latest](https://github.com/bryanljf/Concord/releases/latest).

## Funcionalidades

- **Login com Discord** (OAuth2, escopo `identify`) restrito a uma lista de IDs autorizados.
  Nome e foto vêm do Discord e são atualizados sozinhos; cada um pode definir um apelido.
- **Salas** fixas (Sala 1, 2 e 3) com presença em tempo real: quem está em cada sala e quem
  está **AO VIVO**, mesmo para quem está fora da sala.
- **Transmitir** uma janela ou uma tela inteira em Leve (720p30), Padrão (1080p30) ou Jogo
  (1080p60), H.264 com simulcast. **Áudio por processo**: só o som do aplicativo, sem a call do
  Discord (WASAPI Process Loopback). **Trocar fonte** durante a live sem derrubar quem assiste.
- **Assistir sob demanda**: ao entrar numa sala nada é baixado; cada live aparece como cartão
  com **Assistir**. A live em destaque recebe qualidade cheia e áudio; as demais assistidas
  ficam em miniatura (camada baixa, sem áudio). Menu de clique direito (parar de assistir,
  destacar, pop-out, silenciar), volume por live (padrão 50%, máximo 100%), tela cheia e
  janela pop-out sempre no topo.
- **Som de aviso** quando alguém entra ao vivo na sala em que você está (silenciável por sala
  ou pessoa). Sem notificações do Windows para lives.
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
| Logs e consumo             | `ssh ubuntu@203.0.113.10`, depois `cd ~/concord && docker compose -f infra/docker-compose.yml logs -f` e `docker stats`.                                                                                         |
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

Cada sala aceita até 15 pessoas (`room.max_participants` em `infra/livekit.yaml`). Se faltar
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

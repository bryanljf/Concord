# Concord — guia rápido para o Claude Code

Companion de compartilhamento de tela para um grupo fechado de amigos (o Discord continua para voz/chat).
**Leia `SPEC.md` antes de qualquer fase.** Execute uma fase por vez e pare no fim de cada uma.

## Comandos

```bash
pnpm install              # Node 22+ (.nvmrc = 22), pnpm 12
pnpm dev                  # Electron (apps/desktop) via electron-vite
pnpm dev:api              # Fastify em http://127.0.0.1:3000 (carrega infra/.env se existir)
pnpm dev:livekit          # livekit-server local (binário oficial em infra/local/bin, baixado pelo start.ps1)
pnpm lint                 # eslint + prettier --check
pnpm format               # prettier --write
pnpm typecheck            # tsc em todos os pacotes
pnpm test                 # vitest em todos os pacotes
pnpm build                # build de todos os pacotes
pnpm --filter @concord/desktop dist   # instalador NSIS (apps/desktop/release); publica no GitHub via release.yml
```

Se o binário do Electron não baixar no `pnpm install`, rode
`node node_modules/.pnpm/electron@<versão>/node_modules/electron/install.js`.
Dentro do VS Code, limpe `ELECTRON_RUN_AS_NODE` antes de iniciar o Electron manualmente.

## Estrutura

- `packages/shared` — tipos e constantes compartilhados (presença, DTOs, presets de qualidade). Exporta TS puro.
- `packages/process-audio` — adaptador do addon `loopback-capture` (áudio por processo no Windows, binário pré-compilado); carregado em runtime pelo main, fora do bundle e fora do asar.
- `apps/api` — concord-api (Fastify 5). `src/app.ts` monta o app (testável via `inject`), `src/index.ts` só dá `listen`.
- `apps/desktop` — Electron 44 + electron-vite + React 19. `src/main` (processo principal: bandeja, presença SSE, settings), `src/preload` (ponte IPC; o contrato é `api.d.ts`), `src/renderer` (UI).
- `infra/` — `livekit.yaml` compartilhado, `local/` (hospedagem no PC Windows), docker-compose, exemplos de `.env`/`users.json`.

## Convenções

- Código, nomes e commits em inglês (Conventional Commits); UI e docs para o usuário em pt-BR.
- TypeScript `strict` (+ `noUncheckedIndexedAccess`, `verbatimModuleSyntax`). Sem `any` implícito.
- Dependências com versão fixa no `package.json` (sem `^`). Conferir docs oficiais do LiveKit/Electron antes de usar APIs.
- Electron: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. Tudo que o renderer precisa passa pelo preload.
- Nunca commitar `.env`, `infra/users.json` ou chaves LiveKit. Manter `.env.example` e `users.example.json` atualizados.
- Sem push, repo remoto, release ou ação na VM de produção sem pedir confirmação.
- Se algo da spec se mostrar inviável, parar e propor em vez de improvisar.

## Pins importantes

TS 6.0.x (typescript-eslint exige < 6.1), Vite 7.x (electron-vite 5 exige ≤ 7), Electron 44, Fastify 5, Vitest 5, livekit-server-sdk 2.19, livekit-client 2.22, LiveKit server v1.13.9.

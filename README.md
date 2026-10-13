# Concord

Compartilhamento de tela para um grupo fechado de amigos, feito para conviver com o Discord:
a voz e o chat continuam lá; o Concord só transmite a tela (com o áudio do jogo) por um
servidor [LiveKit](https://livekit.io) próprio, sem passar por VPN.

- **App desktop** (Windows, Electron): fica na bandeja, avisa quando alguém entra ao vivo e
  abre uma janela com visual inspirado no Discord para assistir ou transmitir.
- **Servidor** (`concord-api` + `livekit-server`): pode rodar **no PC de alguém do grupo**
  (Windows, sem Docker) ou numa **VM Oracle Cloud Always Free** (Docker + Caddy).

## Hospedar

| Onde                  | Guia                                                           |
| --------------------- | -------------------------------------------------------------- |
| No seu PC (Windows)   | [infra/local/README-local.md](infra/local/README-local.md)     |
| Oracle Cloud (Fase 5) | [infra/README-deploy.md](infra/README-deploy.md) (em produção) |

Em resumo, no PC: `pnpm install`, `pnpm --filter @concord/api user:add <id> <nome>` para cada
amigo (o comando imprime a chave de acesso), e `powershell -ExecutionPolicy Bypass -File
infra\local\start.ps1`. O script cria o `infra/.env`, baixa o LiveKit (versão fixa, SHA256
conferido), sobe tudo e mostra o endereço que os amigos digitam no app.

## Desenvolvimento

Requisitos: Node 22+ e pnpm 12.

```bash
pnpm install
pnpm dev:livekit   # livekit-server local (janela própria)
pnpm dev:api       # concord-api em http://127.0.0.1:3000 (lê infra/.env)
pnpm dev           # app desktop com hot reload
pnpm lint && pnpm typecheck && pnpm test
pnpm --filter @concord/desktop dist   # instalador NSIS em apps/desktop/release
```

Estrutura: `apps/desktop` (Electron + React), `apps/api` (Fastify), `packages/shared`
(tipos e constantes), `infra/` (configuração do servidor nos dois modos).

A especificação completa, com as fases de desenvolvimento, está em [SPEC.md](SPEC.md);
as convenções do código em [CLAUDE.md](CLAUDE.md).

## Estado

| Fase                                    | Situação                        |
| --------------------------------------- | ------------------------------- |
| 0 — Fundação do monorepo                | concluída                       |
| 1 — Servidor (auth, tokens, presença)   | concluída                       |
| 2 — Desktop: bandeja, onboarding, salas | concluída                       |
| 3a — Transmitir e assistir              | concluída                       |
| 3b — Áudio por processo                 | concluída                       |
| 4 — Polimento da UI                     | concluída                       |
| 5 — Deploy na Oracle                    | concluída                       |
| 6 — Instalador e atualização automática | concluída (publicação pendente) |

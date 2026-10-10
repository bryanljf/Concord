# syntax=docker/dockerfile:1
# =============================================================================================
#  concord-api — imagem de produção para a VM Oracle (Fase 5)
#  PREPARADO, AINDA NÃO EXECUTADO: escrito sem Docker disponível; o primeiro build acontece na
#  VM (ou num PC com Docker), seguindo infra/README-deploy.md.
# =============================================================================================
# Contexto de build = RAIZ do repositório (o api depende do workspace pnpm: packages/shared):
#   docker build -f apps/api/Dockerfile -t concord-api .
# O infra/docker-compose.yml já faz isso (build.context: .., dockerfile: apps/api/Dockerfile).
#
# - node:22-alpine é multi-arch: na VM Ampere A1 o mesmo Dockerfile gera a imagem linux/arm64.
# - Não há etapa de compilação: o api roda TypeScript direto com tsx (dependência de runtime),
#   exatamente como `pnpm --filter @concord/api start` no PC.
# - Só as dependências de produção do api (e o packages/shared) entram na imagem; o app
#   desktop, o Electron e as ferramentas de dev ficam de fora.

FROM node:22-alpine AS base
ENV CI=true
# pnpm na versão fixada em package.json ("packageManager"), via corepack (vem com o Node 22).
# Se o corepack reclamar de assinatura ("Cannot find matching keyid"), a imagem base está
# velha: `docker pull node:22-alpine` ou acrescente antes `npm install -g corepack@latest`.
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@12.10.1 --activate

# ---- dependências de produção ---------------------------------------------------------------
FROM base AS deps
WORKDIR /app
# Só manifestos + lockfile: esta camada só é refeita quando alguma dependência muda.
# Os manifestos dos pacotes que NÃO entram (desktop, process-audio) são copiados apenas para o
# workspace bater com o pnpm-lock.yaml sob --frozen-lockfile; nada deles é instalado.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/desktop/package.json apps/desktop/
COPY packages/shared/package.json packages/shared/
COPY packages/process-audio/package.json packages/process-audio/
# "@concord/api..." = o api e tudo de que ele depende no workspace (packages/shared).
RUN --mount=type=cache,id=concord-pnpm-store,target=/pnpm/store \
    pnpm --filter @concord/api... install --frozen-lockfile --prod

# ---- imagem final ---------------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
# packages/shared não tem dependências (não gera node_modules); só o código entra.
COPY packages/shared/package.json packages/shared/
COPY packages/shared/src packages/shared/src
COPY apps/api/package.json apps/api/
COPY apps/api/src apps/api/src

WORKDIR /app/apps/api
# Usuário sem privilégios (uid 1000, já existe na imagem oficial do Node).
USER node
EXPOSE 3000
# HOST, PORT, USERS_FILE e LIVEKIT_* vêm do ambiente (infra/docker-compose.yml + infra/.env).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-3000}/api/health" || exit 1
CMD ["node", "--import", "tsx", "src/index.ts"]

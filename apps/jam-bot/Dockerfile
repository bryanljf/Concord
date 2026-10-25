# syntax=docker/dockerfile:1
# =============================================================================================
#  concord-jam-bot — imagem de produção para a VM Oracle (toca a Jam no LiveKit)
#  Montada no deploy (ou num PC com Docker), seguindo infra/README-deploy.md.
# =============================================================================================
# Contexto de build = RAIZ do repositório (como o do api):
#   docker build -f apps/jam-bot/Dockerfile -t concord-jam-bot .
# O infra/docker-compose.yml já faz isso (build.context: .., dockerfile: apps/jam-bot/Dockerfile).
#
# - NADA é compilado aqui: a VM (1 OCPU) nunca compila Go. O binário estático chega pronto em
#   apps/jam-bot/dist/jam-bot-linux-<arquitetura> (fora do git; o .dockerignore o reinclui):
#   na VM, o workflow Deploy Oracle o compila no GitHub e o envia por SSH. À mão, de apps/jam-bot:
#     CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags "-s -w" -o dist/jam-bot-linux-arm64 .
#   (GOARCH=amd64 e dist/jam-bot-linux-amd64 para um PC x86_64.)
# - TARGETARCH vem do BuildKit (arm64 na VM Ampere A1, amd64 num PC): escolhe o binário certo.
# - distroless/static: sem shell, sem libc, sem curl; o healthcheck do compose roda o próprio
#   binário (`/jam-bot healthcheck`, que consulta o GET /healthz). Imagem de ~23 MB: ~2 MB do
#   distroless + ~21 MB do binário estático (linux/arm64, -trimpath -s -w).

FROM gcr.io/distroless/static-debian12:nonroot
ARG TARGETARCH
# Dono root e modo 755 sempre (um binário copiado de um PC Windows pode chegar sem o bit de
# execução); o processo, que roda como nonroot, não consegue alterá-lo.
COPY --chmod=0755 apps/jam-bot/dist/jam-bot-linux-${TARGETARCH} /jam-bot
# Teto suave da memória do runtime do Go (o compose limita o container a 128 MB): perto dele o
# GC trabalha mais, em vez de o kernel matar o processo por falta de memória. Medido no PC:
# ~55 MB de working set tocando uma sala com este teto, ~120 MB sem ele.
ENV GOMEMLIMIT=64MiB
# Usuário sem privilégios (nonroot, uid 65532, já existe na imagem). O cache de áudio
# (JAM_CACHE_DIR=/var/lib/concord-jam) é gravado pelo api e montado aqui só para leitura.
USER nonroot
# JAM_BOT_LISTEN (127.0.0.1:3001), JAM_CACHE_DIR e JAM_BOT_TOKEN vêm do ambiente
# (infra/docker-compose.yml). Sem EXPOSE: rede do host, só loopback.
ENTRYPOINT ["/jam-bot"]

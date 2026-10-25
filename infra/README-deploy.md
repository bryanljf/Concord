# Deploy na Oracle Cloud (Fase 5) — Docker + Caddy

> ## Status: em produção desde 2026-10-13
>
> - VM `VM.Standard.A1.Flex` (1 OCPU, 6 GB, Always Free) em `sa-saopaulo-1`, criada pelo
>   Terraform em [`infra/terraform`](terraform), IP no `terraform output`.
> - Domínio `https://<seu-dominio>.duckdns.org` (certificado Let's Encrypt via Caddy). A **versão
>   web** (celular/navegador) fica no mesmo endereço: arquivos estáticos em `~/concord/web/current`,
>   que o deploy envia (seção 6.3 para fazer à mão e para a ordem de lançamento).
> - Deploy automático: cada push em `main` com CI verde roda o workflow `Deploy Oracle`, que
>   entra na VM com uma chave SSH só de deploy (secret do environment `production`).
> - O Minecraft não roda nesta conta: as ressalvas sobre ele abaixo valem só para uma VM
>   compartilhada.

## 0. Provisionamento e CI/CD (conta Oracle nova)

O repositório inclui IaC em [`infra/terraform`](terraform) e o workflow
[`deploy-oracle.yml`](../.github/workflows/deploy-oracle.yml). O Terraform cria apenas os recursos
do Concord — VCN, subnet pública, regras de rede e uma VM Ubuntu ARM64 — e não depende de uma VM
pré-existente. O cloud-init instala Docker, Git e Compose, adiciona `ubuntu` ao grupo `docker` e
clona o repositório. Ele não cria nem imprime `.env` ou `users.json`.

Fluxo recomendado:

1. Criar no OCI um usuário/API key com permissões para o compartment escolhido.
2. Copiar [`terraform.tfvars.example`](terraform/terraform.tfvars.example) para
   `terraform.tfvars`, preencher os OCIDs, região, chave SSH pública e `private_key_path`, e
   executar `terraform init`, `terraform validate`, `terraform plan` e `terraform apply` em
   `infra/terraform`.
3. Anotar o `public_ip` do output e apontar o registro A do DuckDNS para ele. Para produção,
   reserve um public IP no OCI ou atualize o DNS sempre que a VM for recriada.
4. Conectar por SSH, configurar `infra/.env` com o bloco Oracle e copiar o `infra/users.json`
   existente. Use permissões `600` nos dois arquivos.
5. No GitHub, criar um environment chamado `production` e cadastrar
   `ORACLE_HOST`, `ORACLE_USER` (normalmente `ubuntu`), `ORACLE_SSH_PORT` (opcional),
   `ORACLE_SSH_PRIVATE_KEY` e `ORACLE_KNOWN_HOSTS`. O último deve conter a linha obtida de
   `ssh-keyscan -H <IP_DA_VM>` após conferir a fingerprint no console OCI. A chave privada deve
   corresponder à chave pública usada no Terraform e nunca deve ser commitada.
6. Para aprovação manual, configure um required reviewer no environment `production`. Pushes em
   `main` e `workflow_dispatch` executam o deploy **somente depois** que a variável de
   repositório `ORACLE_DEPLOY_ENABLED` for `true` (Settings → Secrets and variables → Actions →
   Variables). Até lá o workflow é pulado, sem falhar.
7. **SSH e IP residencial dinâmico**: o deploy entra na VM a partir dos runners do GitHub, cujos
   IPs mudam a cada execução, e o seu IP de casa também muda. Restringir `allowed_ssh_cidrs` a um
   `/32` bloqueia os dois. Use `allowed_ssh_cidrs = ["0.0.0.0/0"]`: a imagem Ubuntu da Oracle só
   aceita login por chave (sem senha), então a porta aberta não expõe nada sem a chave privada.
   A mudança só altera a security list (`terraform plan` mostra `1 to change, 0 to destroy`).

> O `main.tf` ignora mudanças de imagem e de `cloud-init` na VM: sem isso, a cada nova imagem
> Ubuntu publicada o `terraform apply` destruiria e recriaria o servidor (disco e IP novos).
> Para recriar de propósito: `terraform apply -replace=oci_core_instance.concord`.

Depois que o workflow `CI` termina com sucesso para `main` (ou por disparo manual), o workflow
chama [`deploy-oracle.sh`](scripts/deploy-oracle.sh), que faz fetch do branch, valida o Compose,
executa somente `docker compose -f infra/docker-compose.yml up -d --build`, recarrega o Caddy
(`caddy reload`, sem derrubar conexões) quando o `infra/Caddyfile` mudou e reinicia o LiveKit
quando o `infra/livekit.yaml` mudou (um hash de cada arquivo fica em `~/.concord-*.sha256`), e
verifica os healthchecks. Ele não usa `docker compose down`, `docker system prune`, `docker stop` global ou
qualquer comando que possa afetar outro projeto. `.env`, `users.json`, volumes do Caddy e estado
do Terraform permanecem fora do Git. O `CI` também formata, testa e compila o `jam-bot` (Go,
inclusive para linux/arm64): um erro nele também segura o deploy.

**A VM não compila o `jam-bot`** (um build do zero lá levou ~10 min, e só baixar a imagem do Go
ocupou a OCPU inteira). Antes de chamar o script, o `Deploy Oracle` compila no runner do GitHub,
a partir do commit que passou no CI, o binário estático linux/arm64 e o envia por SSH para
`~/concord/apps/jam-bot/dist/jam-bot-linux-arm64` (grava num nome temporário, confere o SHA-256
e renomeia). Essa pasta fica fora do Git, e o script não roda `git clean`: o binário sobrevive ao
`git reset` e é trocado a cada deploy. A imagem do bot só copia esse binário (~23 MB no total,
sem compilação); sem ele, o script para com `jam-bot-linux-arm64 is missing`. Para fazer o mesmo à
mão, veja a seção 6.1.

**A VM também não compila a versão web** (não tem Node). O mesmo workflow instala o monorepo no
runner (sem baixar o binário do Electron), roda `pnpm --filter @concord/desktop build:web` e envia
o resultado (`apps/desktop/out/web`, um `.tgz` de poucos MB) por SSH para
`~/concord/web/.incoming`; confere o SHA-256 e o `index.html` e só então troca
`~/concord/web/current` pela pasta nova e apaga a anterior (passo "Upload the web app"). Um envio
que falha nunca deixa o site vazio, e a pasta `web/` (fora do git, montada só para leitura em
`/srv/web` do Caddy) só guarda um build. O Caddy serve a pasta direto: o site novo está no ar
assim que o rename acontece, sem reiniciar nada. À mão: seção 6.3.

O `up -d --build` monta todas as imagens; o cache do Docker pula o que não mudou (o jam-bot só é
recriado quando o binário muda). Mudanças no `deploy-oracle.sh` só valem a partir do deploy
**seguinte** ao que as traz (o `git reset` troca o arquivo, mas o bash continua lendo a cópia
que já abriu).

O primeiro deploy é manual depois de preparar `.env`, `users.json`, DNS, callback OAuth do Discord
e firewall. A CI existente deve ser exigida como check obrigatório antes de permitir merge em
`main`.

## O que sobe

| Serviço   | Imagem                                        | Rede                      | Limites           | Função                                                                                                                                                                         |
| --------- | --------------------------------------------- | ------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `livekit` | `livekit/livekit-server:v1.13.9`              | host                      | 1,0 CPU / 1 GB    | SFU WebRTC: sinalização 7880 (só loopback), mídia UDP 50000–50200, TCP 7881                                                                                                    |
| `api`     | build de `apps/api/Dockerfile`                | host, só `127.0.0.1:3000` | 0,25 CPU / 256 MB | chaves de acesso, tokens, presença (SSE), webhook do LiveKit, filas da Jam                                                                                                     |
| `jam-bot` | `apps/jam-bot/Dockerfile` (binário do deploy) | host, só `127.0.0.1:3001` | 0,25 CPU / 128 MB | toca a Jam de cada sala no LiveKit; só lê o cache de áudio que o api grava                                                                                                     |
| `caddy`   | `caddy:2`                                     | host                      | 0,25 CPU / 128 MB | HTTPS automático (Let's Encrypt) nas portas 80/443: proxy para o api (`/api/*`) e o LiveKit (`/rtc*`), e a versão web (arquivos estáticos de `~/concord/web/current`) no resto |

Total: **≤ 1,75 CPU e ≤ 1,5 GB de RAM**, ao lado do Minecraft.

Volumes nomeados: `concord_api-data` (nomes e avatares do Discord, apelidos e as filas da Jam,
gravados pelo api), `concord_jam-cache` (áudio da Jam: o api grava, o jam-bot só lê, no mesmo
caminho `/var/lib/concord-jam` nos dois) e `concord_caddy_data` / `concord_caddy_config`
(certificados).

Pasta `~/concord/web/` (fora do git, bind mount só de leitura em `/srv/web` do Caddy): `current/`
é o build da versão web. O deploy extrai o build novo em `.incoming/`, confere e troca a pasta
inteira (`current` → `previous` → apagada), por isso o compose monta a pasta-mãe e não
`web/current`. Crie-a antes do primeiro `up` com o compose novo (`mkdir -p ~/concord/web`): se o
Docker criar a pasta do bind mount, ela nasce de `root` e o deploy (usuário `ubuntu`) não consegue
gravar nela.

Fluxo: no app, os amigos usam `https://<domínio>` como "URL do servidor"; no celular, abrem
`https://<domínio>/` no navegador. O Caddy manda `/api/*` para o api, `/rtc*` (a sinalização
`wss://<domínio>/rtc` e `/rtc/validate`) para o LiveKit e serve a versão web em todo o resto
(`/` → `index.html`, `/assets/*` com cache de um ano, nomes com hash do Vite); a mídia WebRTC
vai direto do app ou do navegador para o `livekit-server` (UDP 50000–50200, ou TCP 7881 quando o
UDP está bloqueado). As portas 3000 (api), 3001 (jam-bot) e 7880 (sinalização) ficam só no loopback da
VM. Como os containers se enxergam (host x bridge, `host.docker.internal`, webhook) está
explicado nos comentários do `infra/docker-compose.yml`.

Jam: o app de quem adiciona uma música a baixa do YouTube pela própria conexão (o YouTube
bloqueia downloads vindos do IP da VM; a busca, feita pelo api, funciona daqui) e a envia por
`https://<domínio>/api/...` enquanto baixa (em streaming). O api grava o áudio em
`concord_jam-cache` e, com ~128 KB recebidos (~8 s de áudio) e o cabeçalho conferido, manda o
jam-bot tocar o arquivo que ainda está chegando. O bot entra na sala como participante (`@jam`)
assim que uma música entra na fila de uma sala parada, com a sinalização em
`ws://127.0.0.1:7880` e a mídia pelo IP interno da VM, que o LiveKit também anuncia
(`advertise_internal_ip`).

Portas abertas para a internet: **TCP 80, TCP 443, TCP 7881, UDP 50000–50200** (e, opcional,
UDP 443 para HTTP/3). A regra existente do Minecraft (TCP 25565) fica como está. O jam-bot não
precisa de nenhuma.

## 1. Pré-checagem (antes de instalar qualquer coisa)

No console da Oracle:

- Região home da conta: ideal `sa-saopaulo-1` ou `sa-vinhedo-1` (latência para o grupo).
- Compute > Instances > a VM: shape (`VM.Standard.A1.Flex`), OCPUs e memória, **IP público**
  (de preferência _reserved_, para não mudar ao reiniciar), VCN e subnet (seção 3).
- A franquia Always Free do A1 é dividida entre todas as VMs da conta; confira quanto esta VM
  tem antes de contar com 1,75 CPU / 1,5 GB sobrando.

Na VM (SSH, usuário `ubuntu`):

```bash
free -h                 # memória: o Concord precisa de ~1,5 GB sobrando (coluna "available")
nproc                   # vCPUs: o Concord usa até 1,75
uptime                  # carga média atual
df -h /                 # disco: imagens Docker ~450 MB + cache da Jam (até 512 MB) + logs
docker ps               # Docker já existe? o Minecraft roda em container? ("command not found" = não há Docker)
systemctl list-units --type=service --state=running | grep -i -E 'minecraft|java|docker'
sudo ss -tulpn | grep -E ':(80|443|3000|3001|7880|7881|25565)\s'   # alguma porta nossa já ocupada?
sudo iptables -L INPUT -n --line-numbers                           # regras atuais (seção 4)
```

**Mostrar essa saída ao usuário e só continuar com o "ok" dele.** Parar e discutir se: sobra
menos de ~2 GB em `free -h`; a carga média já passa de 1,5 com 2 vCPUs; alguma das portas
80/443/3000/3001/7880/7881 já está em uso; ou o Minecraft roda fora do Docker e o Docker ainda
não existe (instalar é seguro, mas é uma mudança na VM do Minecraft e merece confirmação
explícita).

## 2. DNS

O WebRTC do app exige HTTPS, e o Let's Encrypt exige um nome público apontando para a VM.

- **DuckDNS** (grátis): em <https://www.duckdns.org>, crie um subdomínio (ex.: `concord`) e
  coloque nele o IP público da VM. Como o IP da VM é fixo (reserved), não precisa do
  atualizador automático.
- **Domínio próprio**: registro `A` com o IP público da VM (TTL 300).

Conferir de qualquer PC antes de seguir: `nslookup concord.duckdns.org` tem que devolver o IP
da VM. Sem isso o Caddy não consegue emitir o certificado (seção 6).

## 3. Firewall da Oracle — Security List da VCN

Console > Networking > Virtual Cloud Networks > a VCN da VM > Security Lists > a lista da
subnet da VM > **Ingress Rules** > Add Ingress Rules. Todas com Source CIDR `0.0.0.0/0`,
_stateless_ desmarcado:

| Protocolo | Porta de destino | Para quê                                        |
| --------- | ---------------- | ----------------------------------------------- |
| TCP       | 80               | Caddy: redirecionamento e desafio ACME          |
| TCP       | 443              | Caddy: HTTPS (api e versão web) e WSS (LiveKit) |
| TCP       | 7881             | LiveKit: ICE sobre TCP (fallback do UDP)        |
| UDP       | 50000–50200      | LiveKit: mídia                                  |
| UDP       | 443              | (opcional) HTTP/3 do Caddy                      |

**Manter** a regra existente do Minecraft (TCP 25565) e as demais (SSH 22). Não abrir 3000 nem
7880: ficam atrás do Caddy. Se a VM usa Network Security Groups em vez de Security List, as
mesmas regras vão no NSG.

## 4. Firewall da VM — iptables

A imagem Ubuntu da Oracle bloqueia tudo que não esteja liberado no iptables (as regras ficam em
`/etc/iptables/rules.v4`, via `netfilter-persistent`). Primeiro veja a cadeia atual:

```bash
sudo iptables -L INPUT -n --line-numbers
```

A última regra é um `REJECT`; as novas precisam entrar **antes** dela. Na imagem padrão ela é a
regra 6 (por isso `-I INPUT 6`); se a lista mostrar o `REJECT` em outra posição (a regra do
Minecraft pode ter sido inserida antes), use esse número no lugar do 6:

```bash
sudo iptables -I INPUT 6 -p tcp -m multiport --dports 80,443,7881 -j ACCEPT
sudo iptables -I INPUT 6 -p udp --dport 50000:50200 -j ACCEPT
# opcional, HTTP/3:
# sudo iptables -I INPUT 6 -p udp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

Confira de novo com `sudo iptables -L INPUT -n --line-numbers`: as regras do Concord acima do
`REJECT`, a do Minecraft intacta. Se `netfilter-persistent` não existir:
`sudo apt-get install -y iptables-persistent` (responda "sim" para salvar as regras atuais).

Por que isso importa: `livekit` e `caddy` rodam na rede do host, então os pacotes deles passam
pela cadeia `INPUT` da VM. O `api` não precisa de regra: sua porta é publicada só no loopback.

## 5. Docker, repositório, `.env` e `users.json`

### 5.1 Docker (se o passo 1 mostrou que não existe)

Siga a instalação oficial para Ubuntu (<https://docs.docker.com/engine/install/ubuntu/>): o
repositório `apt` da Docker e os pacotes `docker-ce docker-ce-cli containerd.io
docker-buildx-plugin docker-compose-plugin`. Depois:

```bash
sudo usermod -aG docker $USER   # sair e entrar de novo no SSH para valer
docker --version && docker compose version   # precisa ser "Docker Compose version v2.x"
```

Se o Docker **já existia** (Minecraft em container), não reinstale nem reinicie o serviço
`docker`: reiniciar o daemon derruba os containers, inclusive o do Minecraft. Só confira que o
plugin `compose` v2 está disponível (`docker compose version`); se faltar, instale apenas
`docker-compose-plugin`.

### 5.2 Repositório

```bash
cd ~ && git clone https://github.com/<owner>/Concord.git concord && cd concord
```

Não precisa de Node nem pnpm na VM: o build da imagem instala o que o api usa.

### 5.3 `infra/.env` (bloco B)

```bash
cp infra/.env.example infra/.env
openssl rand -hex 32          # gera o LIVEKIT_API_SECRET (64 caracteres)
nano infra/.env
```

No arquivo, **ative o bloco B** (tire o `#` do começo das cinco linhas obrigatórias entre
`# ---- BLOCO B` e `# ---- fim do bloco B`; as da Jam são opcionais, seção 5.3.3) e
preencha:

```ini
DOMAIN=concord.duckdns.org
LIVEKIT_URL=wss://concord.duckdns.org
LIVEKIT_API_KEY=concord
LIVEKIT_API_SECRET=<o valor do openssl acima>
ROOMS=geral
```

Deixe o bloco A comentado. `HOST`, `PORT`, `TRUST_PROXY`, `USERS_FILE`, `PROFILES_FILE`,
`LIVEKIT_API_URL`, `JAM_BOT_URL`, `JAM_CACHE_DIR` e `JAM_STATE_FILE` não entram aqui: o
`docker-compose.yml` os fixa (eles dependem de como os containers são montados).

Opcional: `WEB_EXTRA_DOMAIN=<outro-dominio>` acrescenta um segundo nome ao mesmo site (um domínio
próprio além do DuckDNS, com certificado próprio; o DNS dele também tem que apontar para a VM).
Vazio ou ausente, só o `DOMAIN` vale. Depois de mudar: `docker compose -f
infra/docker-compose.yml up -d caddy`. O `DISCORD_REDIRECT_URI` continua um só: quem entra pelo
nome extra termina o login em `https://<DOMAIN>/` (o cookie de sessão é desse nome), então o nome
extra serve como porta de entrada, não como segundo endereço independente.

### 5.3.1 OAuth2 oficial do Discord

O login OAuth2 exige uma aplicação criada no
[Discord Developer Portal](https://discord.com/developers/applications), com o redirect URI
exatamente igual ao configurado no `.env`:

```ini
DISCORD_CLIENT_ID=<Client ID da aplicação>
DISCORD_CLIENT_SECRET=<Client Secret; somente na VM>
DISCORD_REDIRECT_URI=https://<seu-dominio>.duckdns.org/api/auth/discord/callback
DISCORD_OAUTH_SCOPES=identify
AUTH_SESSION_SECRET=<openssl rand -hex 32>
AUTH_SESSION_TTL=30d
```

No Portal, registre o redirect URI acima e mantenha somente o escopo `identify`. O Client Secret
não deve ser colocado no desktop, no repositório ou enviado pelo chat. O desktop abre a janela
OAuth em modo sandbox, valida a resposta do callback e armazena somente o token de sessão
assinado pelo Concord (com `safeStorage`). Para autorizar uma pessoa, inclua seu ID numérico
em `discordUserId` no `users.json`; a chave legada continua disponível para compatibilidade.

O mesmo redirect URI atende a versão web: o site chama `/api/auth/discord/login?client=web`, e o
callback, nesse caso, grava o cookie de sessão `concord_session` (HttpOnly, `SameSite=Lax`,
`Secure`, com o mesmo prazo `AUTH_SESSION_TTL`) e redireciona para `/`; se a conta não estiver
liberada, para `/?login_error=not_allowlisted`, e o site mostra o motivo. Nada muda no Portal.

### 5.3.2 Nomes, avatares e apelidos (opcional: `DISCORD_BOT_TOKEN`)

O app mostra cada pessoa com o nome e o avatar exatamente como estão no Discord (o nome de
exibição, ou o nome de usuário quando não há um), ou com o apelido que ela escolheu no app. O api
guarda isso em `/var/lib/concord/profiles.json`, no volume `concord_api-data` (o compose fixa
`PROFILES_FILE`); o `users.json` continua só para leitura.

Sem configuração extra, nome e avatar são atualizados a cada login pelo Discord. Para que mudanças
feitas no Discord apareçam sem novo login, crie um token de bot (opcional):

1. No [Discord Developer Portal](https://discord.com/developers/applications), abra a **mesma
   aplicação** do OAuth2 → **Bot** → **Reset Token** e copie o token (ele só aparece uma vez).
2. Não convide o bot para nenhum servidor e não ative nenhuma _Privileged Gateway Intent_: o api
   só chama `GET /users/{id}` da API REST, que não exige nada disso.
3. No `infra/.env` da VM: `DISCORD_BOT_TOKEN=<token>` e
   `docker compose -f infra/docker-compose.yml up -d`.

Com o token, o api consulta cada pessoa que tem `discordUserId` 5 s depois de subir, a cada 6 h e
sempre que o `users.json` é recarregado, uma por vez e respeitando o limite de requisições do
Discord. Um token inválido só gera um erro no log (`logs api`); o resto continua funcionando. O
token é segredo como o Client Secret: somente na VM, nunca no desktop, no Git ou no chat.

### 5.3.3 Jam (opcional: `JAM_BOT_TOKEN`)

A Jam (fila de músicas do YouTube Music por sala) já vem ligada: o compose sobe o serviço
`jam-bot` e fixa no api `JAM_BOT_URL=http://127.0.0.1:3001`. Como funciona:

- A busca é feita pelo api, a partir da VM. O download do áudio, não: o YouTube bloqueia
  downloads vindos do IP da VM, então o app de quem adiciona a música baixa o áudio com o yt-dlp
  pela própria conexão (anônimo, sem conta) e o envia ao api enquanto baixa
  (`PUT /api/rooms/<sala>/jam/...`, em streaming pelo Caddy, até 32 MB por música e músicas de
  até 20 min). O app também adianta em memória os resultados mais prováveis da busca, então o
  envio costuma começar de bytes que já estão no PC de quem pediu.
- O api grava o áudio em `/var/lib/concord-jam` (volume `concord_jam-cache`, até
  `JAM_CACHE_MAX_MB`, padrão 512, e no máximo `JAM_CACHE_TTL_HOURS` horas fora da fila, padrão 3)
  e as filas em `/var/lib/concord/jam-state.json` (volume `concord_api-data`, para sobreviverem a
  um reinício). Uma música que ainda está no cache (tocada nas últimas 3 h) começa sem envio.
- O `jam-bot` (Go, imagem distroless de ~23 MB, sem shell) monta o mesmo volume **só para
  leitura** e, a pedido do api, entra na sala como o participante `@jam` (já quando a primeira
  música entra na fila, para a conexão ao LiveKit correr junto com o download) e publica uma
  faixa estéreo (`concord:music:jam`) com o Opus do arquivo, sem recodificar. Ele começa a tocar
  com ~128 KB do arquivo (~8 s de áudio) e segue lendo enquanto o envio continua. Ele não recebe
  o `.env` (nenhum segredo do LiveKit ou do Discord): o api lhe entrega um token do LiveKit por
  sala.

O bot escuta só em `127.0.0.1:3001`, mas qualquer processo da VM alcança o loopback. Para que só
o api consiga comandá-lo, defina um segredo compartilhado no `infra/.env` (recomendado):

```bash
openssl rand -hex 32          # gera o JAM_BOT_TOKEN
nano infra/.env               # JAM_BOT_TOKEN=<o valor acima>, no bloco B
docker compose -f infra/docker-compose.yml up -d   # recria api e jam-bot com o token
```

O mesmo valor do `.env` chega aos dois containers (ao api pelo `env_file`, ao bot por
interpolação no compose); depois de mudá-lo, rode `up -d` sem nome de serviço, para recriar os
dois juntos. Sem o token, o bot aceita qualquer pedido vindo da própria VM. Opcional também:
`JAM_CACHE_MAX_MB` (padrão 512) e `JAM_CACHE_TTL_HOURS` (horas inteiras, padrão 3, `0` desliga o
prazo) limitam o cache (seção 8.1).

Custo, medido nesta VM: ~0,75% de um núcleo por sala tocando (~1,9% com 3 salas, ~0,2% em
pausa) e ~50 MB de RAM (RSS), enviando em estéreo o Opus original do YouTube (~130 kbps), sem
decodificar. O compose limita o `jam-bot` a 0,25 CPU e 128 MB.

### 5.4 `infra/users.json`

Mesmo formato da hospedagem local. Duas opções:

- **No PC Windows** (recomendado — usa o script já testado): na raiz do repositório,
  `pnpm --filter @concord/api user:add bryan Bryan` para cada pessoa (imprime a chave de acesso
  de cada um) e copie o arquivo: `scp infra\users.json ubuntu@<ip-da-vm>:~/concord/infra/users.json`.
  Se o grupo já tem um `users.json` da hospedagem local, pode reaproveitá-lo: as chaves
  continuam as mesmas, só muda a URL do servidor no app.
- **Na VM**, a partir de `infra/users.example.json`: gere uma chave por pessoa com
  `openssl rand -base64 24 | tr '+/' '-_'` (32 caracteres) e escreva o JSON à mão
  (`id` com 2–32 caracteres entre `a-z`, `0-9`, `-` e `_`, começando com letra ou número).

Permissões: `chmod 600 infra/.env infra/users.json`. O api roda no container como uid 1000, o
mesmo do usuário `ubuntu` (confira com `id -u`); se o seu usuário tiver outro uid, use
`chmod 644 infra/users.json` ou `sudo chown 1000 infra/users.json`.

## 6. Subir e validar

**Antes de rodar, mostrar ao usuário o que vai subir** (os quatro serviços, os limites, as
portas) e pedir confirmação.

### 6.1 Binário do `jam-bot` (deploy à mão, sem o CI)

A imagem do jam-bot só copia `apps/jam-bot/dist/jam-bot-linux-arm64`, que não está no Git. O
workflow `Deploy Oracle` o envia sozinho; à mão (primeira subida, ou sem o GitHub Actions),
compile-o em qualquer PC com Go, **a partir do mesmo commit** que vai rodar na VM (o
`deploy-oracle.sh` faz `git reset --hard origin/main`), e copie para a VM:

```bash
cd apps/jam-bot
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags "-s -w" -o jam-bot-linux-arm64 .
ssh ubuntu@<ip-da-vm> 'mkdir -p ~/concord/apps/jam-bot/dist'
scp jam-bot-linux-arm64 ubuntu@<ip-da-vm>:concord/apps/jam-bot/dist/jam-bot-linux-arm64
ssh ubuntu@<ip-da-vm> 'chmod 755 ~/concord/apps/jam-bot/dist/jam-bot-linux-arm64'
```

No PowerShell, troque a linha do `go build` por:

```powershell
$env:CGO_ENABLED = '0'; $env:GOOS = 'linux'; $env:GOARCH = 'arm64'
go build -trimpath -ldflags "-s -w" -o jam-bot-linux-arm64 .
Remove-Item Env:CGO_ENABLED, Env:GOOS, Env:GOARCH
```

Depois, rode o deploy na VM (`bash ~/concord/infra/scripts/deploy-oracle.sh`) ou suba direto
como abaixo.

### 6.2 Subir

Na raiz do repositório:

```bash
docker compose -f infra/docker-compose.yml up -d --build
docker compose -f infra/docker-compose.yml ps        # os 4 "Up"; api e jam-bot "healthy" após ~30 s
docker compose -f infra/docker-compose.yml logs -f   # Ctrl+C para sair
```

O compose lê `infra/.env` sozinho (é o `.env` da pasta do arquivo compose). O primeiro
`--build` baixa `node:22-alpine` e instala as dependências do api (alguns minutos na A1); a
imagem do `jam-bot` só copia o binário sobre a `distroless/static` (~23 MB: ~2 MB da base e
~21 MB do binário estático, sem compilar nada).

Nos logs, o que confirma que deu certo:

- `livekit`: `starting LiveKit server {"portHttp": 7880, ... "version": "1.13.9", "rtc.portTCP": 7881, "rtc.portICERange": [50000, 50200]}`
  e `using external IPs {"ips": ["<IP PÚBLICO da VM>/<IP privado>"]}` — tem que aparecer o IP
  público; se só o privado aparecer, o STUN falhou e ninguém de fora conecta.
- `api`: `concord-api pronto` com `rooms` e `users`. Um aviso `LiveKit presence resync failed`
  logo no início é normal enquanto o LiveKit sobe; some sozinho (`resync recovered`).
- `caddy`: `certificate obtained successfully` para o domínio. Se ficar repetindo erros ACME,
  veja a seção 10.
- `jam-bot`: `healthy` no `ps`. Na VM, `curl -s http://127.0.0.1:3001/healthz` responde
  `{"ok":true}` (a imagem não tem shell nem curl: teste do host).

Testes, de qualquer PC (no PowerShell use `curl.exe`, não `curl`):

```bash
curl -s https://concord.duckdns.org/api/health
# {"ok":true}

curl -s -X POST https://concord.duckdns.org/api/token \
  -H "Authorization: Bearer <chave de um usuário>" -H "Content-Type: application/json" \
  -d '{"room":"geral"}'
# {"token":"eyJ...","url":"wss://concord.duckdns.org","expiresAt":...}
```

Com o `token` da resposta, abra <https://livekit.io/connection-test>, informe
`wss://concord.duckdns.org` e o token e rode: todos os passos têm que passar, inclusive os de
mídia (eles validam a faixa UDP 50000–50200 / TCP 7881). Por fim, o teste real: dois amigos
colocam `https://concord.duckdns.org` e a chave no app, entram na sala `geral` e um transmite.
Para a Jam: um deles busca e adiciona uma música, o outro clica em **Ouvir**. Para a versão web:
um terceiro abre `https://concord.duckdns.org/` no celular, entra com o Discord e assiste.

Uso de recursos: `docker stats --no-stream` mostra CPU/RAM de todos os containers (inclusive o
do Minecraft, se for container). Os limites do compose aparecem na coluna `LIMIT`.

### 6.3 Versão web: à mão, Caddyfile e ordem de lançamento

O workflow `Deploy Oracle` compila e envia o site sozinho (seção 0); o jeito mais simples de
refazer só isso é **Actions → Deploy Oracle → Run workflow**. Sem o GitHub Actions, faça o mesmo de
um PC com Node e pnpm, **a partir do mesmo commit** que está na VM:

```bash
pnpm install
pnpm --filter @concord/desktop build:web          # gera apps/desktop/out/web
tar -C apps/desktop/out/web -czf web.tgz .
ssh ubuntu@<ip-da-vm> 'mkdir -p ~/concord/web && rm -rf ~/concord/web/.incoming && mkdir ~/concord/web/.incoming'
scp web.tgz ubuntu@<ip-da-vm>:concord/web/.incoming.tgz
ssh ubuntu@<ip-da-vm> 'cd ~/concord/web && tar -C .incoming -xzf .incoming.tgz && rm .incoming.tgz && test -f .incoming/index.html && rm -rf previous && if [ -d current ]; then mv current previous; fi && mv .incoming current && rm -rf previous'
```

(No PowerShell, `tar`, `scp` e `ssh` existem no Windows 10/11; mantenha as aspas simples dos
`ssh`.) O Caddy serve a pasta direto: nada precisa reiniciar. Para conferir, de qualquer PC:

```bash
curl -sI https://concord.duckdns.org/ | head -1               # HTTP/2 200
curl -sI https://concord.duckdns.org/ | grep -i content-type   # text/html
```

Mudanças no `infra/Caddyfile` chegam pelo deploy: o script faz `caddy reload` (sem derrubar
conexões) sempre que o arquivo muda; um Caddyfile inválido faz o reload falhar e a configuração
anterior continua no ar. Antes de dar push num Caddyfile mexido, valide a sintaxe com o Docker
(na VM ou num PC; só lê o arquivo):

```bash
docker run --rm -e DOMAIN=concord.duckdns.org -e WEB_EXTRA_DOMAIN= \
  -v "$PWD/infra/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2 caddy validate --config /etc/caddy/Caddyfile
```

Para aplicar à mão depois de um `git pull`:
`docker compose -f infra/docker-compose.yml exec -T caddy caddy reload --config /etc/caddy/Caddyfile`.

**Ordem de lançamento da versão web** (na primeira vez e em qualquer versão que mude o contrato
entre api, desktop e site):

1. **Release do desktop primeiro**, com o api antigo ainda no ar: o desktop novo funciona com ele
   (o api antigo ignora o `fetch=1`). Como todo push em `main` com CI verde já faz deploy, desligue
   antes a variável `ORACLE_DEPLOY_ENABLED` (Settings → Variables), faça o push, crie a tag
   `vX.Y.Z` e espere **todo mundo atualizar** (Configurações → Sobre mostra a versão).
2. **Deploy do api**: religue `ORACLE_DEPLOY_ENABLED` e rode `Actions → Deploy Oracle → Run
workflow`. Com o api novo, um desktop até a v0.3.1 não baixa mais as músicas que adiciona: o
   api o trata como a versão web e pede a um desktop atualizado (sem nenhum aberto, a música é
   recusada com "Ninguém com o Concord aberto no PC…"). Desktops antigos também ignoram os
   participantes `~web` (não mostram quem está pelo celular nem a câmera dele).
3. Só então divulgar o link `https://<domínio>/` no grupo.

## 7. Verificar que o Minecraft continua funcionando (obrigatório)

Depois do `up`, **entrar no servidor de Minecraft** a partir de um cliente e jogar alguns
minutos. Também: `sudo ss -tulpn | grep 25565` (continua escutando), `docker ps` ou
`systemctl status <serviço>` (continua rodando desde antes, sem reinício), e `docker stats` /
`free -h` (o Minecraft não ficou sem memória). Se algo piorou, `docker compose -f
infra/docker-compose.yml down` desliga só os quatro containers do Concord (nunca use `docker stop
$(docker ps -q)`, `docker system prune` nem `docker compose down` de outro projeto na VM).

## 8. Manutenção

Todos os comandos a partir de `~/concord`, sempre com `-f infra/docker-compose.yml` (senão o
compose não encontra o projeto e nada acontece — ou, pior, acerta outro projeto da VM).

- **Logs**: `docker compose -f infra/docker-compose.yml logs -f` (ou `logs -f api`, `jam-bot`,
  `livekit`, `caddy`).
- **Atualizar o Concord**: o deploy automático (push em `main`). À mão: `git pull`, o binário
  novo do jam-bot (seção 6.1, se `apps/jam-bot` mudou), o build novo da versão web (seção 6.3,
  se `apps/desktop` ou `packages/shared` mudaram) e
  `docker compose -f infra/docker-compose.yml up -d --build`. Só o api e o jam-bot são
  reconstruídos (o api quando o código dele mudou, o jam-bot quando o binário mudou); o LiveKit e
  o Caddy só reiniciam se o compose mudou (um `Caddyfile` mudado pede um `caddy reload`, seção
  6.3; o deploy faz isso sozinho). Reiniciar o jam-bot interrompe a música da Jam enquanto ele
  sobe de novo.
- **Atualizar o LiveKit**: mude a tag em `infra/docker-compose.yml` (e mantenha igual em
  `infra/local/start.ps1` e `infra/docker-compose.dev.yml`), leia as notas da release em
  <https://github.com/livekit/livekit/releases> e rode `up -d`. O `infra/livekit.yaml` é
  validado no start: `could not parse config` indica chave desconhecida na versão nova.
- **Adicionar/remover amigo**: edite `infra/users.json` (ou gere no PC e copie com `scp`) e
  rode `docker compose -f infra/docker-compose.yml restart api`. O api recarrega o arquivo
  sozinho quando ele é editado no lugar, mas editores que gravam um arquivo novo (e `scp`)
  trocam o inode e o container continua vendo o antigo — o `restart` resolve sempre.
- **Mudar o `.env`** (salas, segredo, domínio, `WEB_EXTRA_DOMAIN`, `JAM_BOT_TOKEN`): `docker
compose -f infra/docker-compose.yml up -d` recria só os containers afetados.
- **Backup**: `infra/.env` e `infra/users.json` (fora do git). Os apelidos e os nomes/avatares
  importados do Discord ficam no volume `concord_api-data` (`profiles.json`); se ele se perder,
  nomes e avatares voltam no próximo login ou sincronização, mas os apelidos não. As filas da
  Jam (`jam-state.json`) ficam no mesmo volume. O áudio da Jam (`concord_jam-cache`) é só cache,
  sem backup. Os certificados ficam no volume
  `concord_caddy_data`; não precisa de backup (o Caddy re-emite), mas não apague o volume à toa:
  o Let's Encrypt limita a 5 certificados iguais por semana.
- **Parar o Concord**: `docker compose -f infra/docker-compose.yml down` (mantém os volumes);
  `up -d` de novo para voltar. Com `restart: unless-stopped`, os containers voltam sozinhos
  quando a VM reinicia.

### 8.1 Armazenamento e limpeza

Nada do Concord deve crescer sem limite no disco da VM. O que segura cada parte:

| O quê                                    | Limite                                                                                                                                                                                                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Logs dos containers                      | `json-file` com rotação (`x-logging` no compose): 3 arquivos de 10 MB por serviço, ~30 MB cada. Sem isso, o log do api crescia ~55 MB/dia.                                                                                                                                      |
| Cache de build (BuildKit)                | O deploy roda `docker builder prune -f --filter until=168h`: fica só a última semana, o que mantém os deploys rotineiros rápidos. Antes ele crescia a cada deploy (chegou a 4 GB).                                                                                              |
| Imagens antigas                          | O deploy roda `docker image prune -f`: só imagens sem tag (as versões anteriores do api e do jam-bot). Nunca `docker system prune`, nunca volumes, nunca imagens com tag de outros projetos.                                                                                    |
| Áudio da Jam (`concord_jam-cache`)       | O api apaga as músicas fora da fila que ninguém tocou nas últimas `JAM_CACHE_TTL_HOURS` horas (padrão 3; `0` desliga o prazo) e, quando o cache passa de `JAM_CACHE_MAX_MB` (padrão 512), as tocadas há mais tempo. Confere ao subir, a cada 10 minutos e depois de cada envio. |
| `concord_api-data`, `concord_caddy_data` | Pequenos (perfis, filas da Jam, certificados); não precisam de limpeza.                                                                                                                                                                                                         |
| Versão web (`~/concord/web`)             | Só um build (poucos MB): a cada deploy, `.incoming` é apagado antes do envio e a pasta `current` anterior é apagada logo depois da troca. Nada mais fica lá.                                                                                                                    |

O journald (logs do sistema) é gerenciado pelo Ubuntu, fora do Concord. As duas limpezas ficam
no `deploy-oracle.sh` e só rodam depois de um `up -d --build` bem-sucedido; como toda mudança no
script, só valem a partir do deploy **seguinte** ao que as traz. Mudar as opções de log recria
todos os containers no deploy seguinte, o LiveKit inclusive (quem estiver online reconecta em
alguns segundos): faça esse deploy quando ninguém estiver ao vivo.

Para conferir:

```bash
df -h /                                   # disco livre
docker system df                          # imagens, containers, volumes e cache de build
sudo du -sh /var/lib/docker/volumes/*     # tamanho de cada volume (concord_jam-cache etc.)
```

## 9. Ociosidade (Always Free)

A Oracle pode recuperar VMs Always Free que passem **7 dias** com CPU, rede e memória abaixo
de 20% de uso. O Minecraft normalmente já evita isso; sem ele, contas convertidas para
_Pay As You Go_ (mesmo sem gastar nada) não sofrem essa regra.

## 10. Problemas comuns

| Sintoma                                                                                                | Onde olhar / o que fazer                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `caddy` repete erros ACME / `https://` não responde                                                    | DNS ainda não aponta para a VM (`nslookup`); TCP 80/443 fechados na Security List ou no iptables (seção 3/4). Teste `curl -I http://<domínio>` de fora.                                                                                                                                                                                                                                                                                          |
| `/api/health` ok, mas o app não conecta ao LiveKit                                                     | `logs livekit` sem o IP público em `using external IPs`; TCP 7881 / UDP 50000–50200 fechados. O connection-test da seção 6 aponta qual etapa falha.                                                                                                                                                                                                                                                                                              |
| Presença vazia no app (ninguém aparece na sidebar)                                                     | O webhook não chega ao api: `logs livekit \| grep -i webhook`; `sudo ss -tlnp \| grep 3000` tem que mostrar `127.0.0.1:3000`; `LIVEKIT_API_KEY=concord` igual a `webhook.api_key`.                                                                                                                                                                                                                                                               |
| `api` fica `unhealthy` / reinicia                                                                      | `logs api`: `configuração inválida` (variável faltando no `.env`), `arquivo de usuários não encontrado` (`infra/users.json` ausente ou sem permissão de leitura, seção 5.4).                                                                                                                                                                                                                                                                     |
| A Jam não aparece no app / erro `jam_unavailable`                                                      | `docker compose -f infra/docker-compose.yml ps jam-bot` tem que estar `Up (healthy)`. `logs api`: o api não alcança o bot (`JAM_BOT_URL=http://127.0.0.1:3001`, fixado pelo compose) ou recebe `401` (o `JAM_BOT_TOKEN` mudou e só um container foi recriado, por exemplo com `up -d api`: rode `up -d` sem nome de serviço).                                                                                                                    |
| `jam-bot` fica `unhealthy` / reinicia                                                                  | `logs jam-bot`. Porta 3001 já ocupada na VM (`sudo ss -tlnp \| grep 3001`). Falta de memória: `docker inspect concord-jam-bot-1 --format '{{.State.OOMKilled}}'` mostra `true`; suba o `mem_limit` dele no compose. O healthcheck é o próprio binário (`/jam-bot healthcheck`), porque a imagem não tem shell.                                                                                                                                   |
| Música some da fila logo depois de adicionada (envio recusado)                                         | `logs api` mostra o motivo: arquivo acima de 32 MB ou música acima de 20 min, áudio que não é Opus em WebM (`invalid_audio`, recusado pelo jam-bot), envio que passou de 3 min, ou `EACCES` em `/var/lib/concord-jam` (o volume ficou sem o dono `node`: `docker compose -f infra/docker-compose.yml exec -u root api chown node:node /var/lib/concord-jam`). Falhas de download do YouTube acontecem no app de quem adicionou, não no servidor. |
| Música para no meio e sai da fila                                                                      | Quase sempre o envio de quem a adicionou caiu (a conexão dessa pessoa): o bot toca enquanto o áudio ainda chega, e se o envio falha (ou passa 30 s sem dados novos) ele para a música, que sai da fila. `logs api` / `logs jam-bot` mostram o envio interrompido; adicionar de novo resolve. Se acontece com todo mundo, veja a linha acima (`EACCES`, limites) e `docker stats` (CPU/memória do api e do bot).                                  |
| A Jam toca na fila, mas ninguém ouve                                                                   | `logs jam-bot` / `logs api` com `livekit_error`: o bot não alcançou `ws://127.0.0.1:7880` ou a mídia não fechou pelo IP interno da VM (`advertise_internal_ip: true` no `infra/livekit.yaml` tem que continuar).                                                                                                                                                                                                                                 |
| Deploy para com `jam-bot-linux-arm64 is missing`, ou o build da imagem do `jam-bot` não acha o binário | O binário não chegou a `~/concord/apps/jam-bot/dist/`: veja o passo "Upload the jam bot binary" do workflow `Deploy Oracle` (SSH) ou envie à mão (seção 6.1).                                                                                                                                                                                                                                                                                    |
| Workflow `Deploy Oracle` falha em "Build the jam bot" (`missing go.sum entry`, erro de compilação)     | O job `jam-bot` do CI costuma pegar isso antes. No PC: `go -C apps/jam-bot mod tidy` e `go -C apps/jam-bot build ./...`, commit e push. Nada muda na VM até um deploy passar.                                                                                                                                                                                                                                                                    |
| Build falha com `ERR_PNPM_OUTDATED_LOCKFILE`                                                           | O `pnpm-lock.yaml` está defasado em relação aos `package.json`: no PC, `pnpm install`, commit do lockfile, `git pull` na VM.                                                                                                                                                                                                                                                                                                                     |
| Build falha em `corepack` (`Cannot find matching keyid`)                                               | Imagem base antiga: `docker pull node:22-alpine` e repita o build (ver comentário no Dockerfile).                                                                                                                                                                                                                                                                                                                                                |
| `docker compose` reclama de `ports` com `network_mode: host`                                           | Versão antiga do Compose; é preciso o plugin v2 (`docker compose version`). Nenhum serviço tem `ports`, de propósito.                                                                                                                                                                                                                                                                                                                            |
| Minecraft lento/travando depois do deploy                                                              | `docker stats`: se `livekit` bate em 1 CPU com várias transmissões, reduza os presets no app ou o número de streams; os limites do compose protegem o resto da VM, mas não a rede.                                                                                                                                                                                                                                                               |
| `https://<domínio>/` responde 404 (o app desktop funciona)                                             | Não há build em `~/concord/web/current`: veja o passo "Upload the web app" do workflow `Deploy Oracle` ou envie à mão (seção 6.3). O deploy avisa `web/current/index.html is missing`. Se a pasta `web/` nasceu de `root` (criada pelo Docker), `sudo chown -R ubuntu:ubuntu ~/concord/web`.                                                                                                                                                     |
| Deploy para em `caddy reload` (`infra/Caddyfile changed: reloading caddy`)                             | Caddyfile inválido: a configuração anterior continua no ar. Valide com o `caddy validate` da seção 6.3, corrija e dê push; `logs caddy` mostra a linha do erro.                                                                                                                                                                                                                                                                                  |
| Na versão web, o login volta para `/?login_error=...`                                                  | `oauth_exchange_failed` / `invalid_oauth_state`: `DISCORD_REDIRECT_URI` diferente do registrado no Portal, ou cookies bloqueados no navegador (o estado do OAuth é um cookie). `not_allowlisted`: ID do Discord fora do `users.json`.                                                                                                                                                                                                            |
| Na versão web, "Ninguém com o Concord aberto no PC para baixar essa música agora" (`no_downloader`)    | Normal quando nenhum desktop (Windows) está com o Concord aberto e conectado: só eles baixam do YouTube (o IP da VM é bloqueado). Não é erro do servidor.                                                                                                                                                                                                                                                                                        |

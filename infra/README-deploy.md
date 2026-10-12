# Deploy na Oracle Cloud (Fase 5) — Docker + Caddy

> ## Status: preparado, ainda não executado
>
> Os arquivos desta fase — `apps/api/Dockerfile`, `.dockerignore`, `infra/docker-compose.yml`,
> `infra/Caddyfile` e este guia — foram escritos **sem acesso a uma VM e sem Docker instalado**:
> nenhum comando abaixo foi executado ainda. Por enquanto o grupo hospeda no PC
> ([infra/local/README-local.md](local/README-local.md)); este guia fica pronto para quando (e
> se) a Oracle entrar.
>
> **Toda ação na VM exige a confirmação do usuário antes**: mostrar o comando e o que ele faz,
> esperar o "sim", executar, mostrar o resultado. Vale para cada passo, inclusive os só de
> leitura (`free -h`, `docker ps`). A VM também roda um **servidor de Minecraft (porta 25565)**:
> nada aqui pode pará-lo, reiniciá-lo, mexer no container/serviço dele ou na porta dele. Se
> algum passo exigir isso, parar e discutir.

## O que sobe

| Serviço   | Imagem                           | Rede                        | Limites           | Função                                                                       |
| --------- | -------------------------------- | --------------------------- | ----------------- | ---------------------------------------------------------------------------- |
| `livekit` | `livekit/livekit-server:v1.13.9` | host                        | 1,0 CPU / 1 GB    | SFU WebRTC: sinalização 7880 (só loopback), mídia UDP 50000–50200, TCP 7881  |
| `api`     | build de `apps/api/Dockerfile`   | bridge, só `127.0.0.1:3000` | 0,25 CPU / 256 MB | chaves de acesso, tokens, presença (SSE), webhook do LiveKit                 |
| `caddy`   | `caddy:2`                        | host                        | 0,25 CPU / 128 MB | HTTPS automático (Let's Encrypt) nas portas 80/443, proxy para api e LiveKit |

Total: **≤ 1,5 CPU e ≤ 1,4 GB de RAM** (SPEC 7), ao lado do Minecraft.

Fluxo: no app, os amigos usam `https://<domínio>` como "URL do servidor". O Caddy manda
`/api/*` para o api e todo o resto (`wss://<domínio>`) para o LiveKit; a mídia WebRTC vai
direto do app para o `livekit-server` (UDP 50000–50200, ou TCP 7881 quando o UDP está
bloqueado). As portas 3000 (api) e 7880 (sinalização) ficam só no loopback da VM. Como os
containers se enxergam (host x bridge, `host.docker.internal`, webhook) está explicado nos
comentários do `infra/docker-compose.yml`.

Portas abertas para a internet: **TCP 80, TCP 443, TCP 7881, UDP 50000–50200** (e, opcional,
UDP 443 para HTTP/3). A regra existente do Minecraft (TCP 25565) fica como está.

## 1. Pré-checagem (antes de instalar qualquer coisa)

No console da Oracle:

- Região home da conta: ideal `sa-saopaulo-1` ou `sa-vinhedo-1` (latência para o grupo).
- Compute > Instances > a VM: shape (`VM.Standard.A1.Flex`), OCPUs e memória, **IP público**
  (de preferência _reserved_, para não mudar ao reiniciar), VCN e subnet (seção 3).
- A franquia Always Free do A1 é dividida entre todas as VMs da conta; confira quanto esta VM
  tem antes de contar com 1,5 CPU / 1,4 GB sobrando.

Na VM (SSH, usuário `ubuntu`):

```bash
free -h                 # memória: o Concord precisa de ~1,4 GB sobrando (coluna "available")
nproc                   # vCPUs: o Concord usa até 1,5
uptime                  # carga média atual
df -h /                 # disco: imagens Docker ~400 MB + logs
docker ps               # Docker já existe? o Minecraft roda em container? ("command not found" = não há Docker)
systemctl list-units --type=service --state=running | grep -i -E 'minecraft|java|docker'
sudo ss -tulpn | grep -E ':(80|443|3000|7880|7881|25565)\s'   # alguma porta nossa já ocupada?
sudo iptables -L INPUT -n --line-numbers                      # regras atuais (seção 4)
```

**Mostrar essa saída ao usuário e só continuar com o "ok" dele.** Parar e discutir se: sobra
menos de ~2 GB em `free -h`; a carga média já passa de 1,5 com 2 vCPUs; alguma das portas
80/443/7881 já está em uso; ou o Minecraft roda fora do Docker e o Docker ainda não existe
(instalar é seguro, mas é uma mudança na VM do Minecraft e merece confirmação explícita).

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

| Protocolo | Porta de destino | Para quê                                 |
| --------- | ---------------- | ---------------------------------------- |
| TCP       | 80               | Caddy: redirecionamento e desafio ACME   |
| TCP       | 443              | Caddy: HTTPS (api) e WSS (LiveKit)       |
| TCP       | 7881             | LiveKit: ICE sobre TCP (fallback do UDP) |
| UDP       | 50000–50200      | LiveKit: mídia                           |
| UDP       | 443              | (opcional) HTTP/3 do Caddy               |

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

No arquivo, **ative o bloco B** (tire o `#` do começo das cinco linhas entre
`# ---- BLOCO B` e `# ---- fim do bloco B`) e preencha:

```ini
DOMAIN=concord.duckdns.org
LIVEKIT_URL=wss://concord.duckdns.org
LIVEKIT_API_KEY=concord
LIVEKIT_API_SECRET=<o valor do openssl acima>
ROOMS=geral
```

Deixe o bloco A comentado. `HOST`, `PORT`, `TRUST_PROXY`, `USERS_FILE` e `LIVEKIT_API_URL` não
entram aqui: o `docker-compose.yml` os fixa (eles dependem de como os containers são montados).

### 5.3.1 OAuth2 oficial do Discord

O login OAuth2 exige uma aplicação criada no
[Discord Developer Portal](https://discord.com/developers/applications), com o redirect URI
exatamente igual ao configurado no `.env`:

```ini
DISCORD_CLIENT_ID=<Client ID da aplicação>
DISCORD_CLIENT_SECRET=<Client Secret; somente na VM>
DISCORD_REDIRECT_URI=https://exemplo.duckdns.org/api/auth/discord/callback
DISCORD_OAUTH_SCOPES=identify
AUTH_SESSION_SECRET=<openssl rand -hex 32>
AUTH_SESSION_TTL=30d
```

No Portal, registre o redirect URI acima e mantenha somente o escopo `identify`. O Client Secret
não deve ser colocado no desktop, no repositório ou enviado pelo chat. O desktop abre a janela
OAuth em modo sandbox, valida a resposta do callback e armazena somente o token de sessão
assinado pelo Concord (com `safeStorage`). Para autorizar uma pessoa, inclua seu ID numérico
em `discordUserId` no `users.json`; a chave legada continua disponível para compatibilidade.

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

**Antes de rodar, mostrar ao usuário o que vai subir** (as três imagens, os limites, as portas)
e pedir confirmação. Depois, na raiz do repositório:

```bash
docker compose -f infra/docker-compose.yml up -d --build
docker compose -f infra/docker-compose.yml ps        # os 3 "Up"; api "healthy" após ~30 s
docker compose -f infra/docker-compose.yml logs -f   # Ctrl+C para sair
```

O compose lê `infra/.env` sozinho (é o `.env` da pasta do arquivo compose). O primeiro
`--build` baixa `node:22-alpine` e instala as dependências do api (alguns minutos na A1).

Nos logs, o que confirma que deu certo:

- `livekit`: `starting LiveKit server {"portHttp": 7880, ... "version": "1.13.9", "rtc.portTCP": 7881, "rtc.portICERange": [50000, 50200]}`
  e `using external IPs {"ips": ["<IP PÚBLICO da VM>/<IP privado>"]}` — tem que aparecer o IP
  público; se só o privado aparecer, o STUN falhou e ninguém de fora conecta.
- `api`: `concord-api pronto` com `rooms` e `users`. Um aviso `LiveKit presence resync failed`
  logo no início é normal enquanto o LiveKit sobe; some sozinho (`resync recovered`).
- `caddy`: `certificate obtained successfully` para o domínio. Se ficar repetindo erros ACME,
  veja a seção 10.

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

Uso de recursos: `docker stats --no-stream` mostra CPU/RAM de todos os containers (inclusive o
do Minecraft, se for container). Os limites do compose aparecem na coluna `LIMIT`.

## 7. Verificar que o Minecraft continua funcionando (obrigatório)

Depois do `up`, **entrar no servidor de Minecraft** a partir de um cliente e jogar alguns
minutos. Também: `sudo ss -tulpn | grep 25565` (continua escutando), `docker ps` ou
`systemctl status <serviço>` (continua rodando desde antes, sem reinício), e `docker stats` /
`free -h` (o Minecraft não ficou sem memória). Se algo piorou, `docker compose -f
infra/docker-compose.yml down` desliga só os três containers do Concord (nunca use `docker stop
$(docker ps -q)`, `docker system prune` nem `docker compose down` de outro projeto na VM).

## 8. Manutenção

Todos os comandos a partir de `~/concord`, sempre com `-f infra/docker-compose.yml` (senão o
compose não encontra o projeto e nada acontece — ou, pior, acerta outro projeto da VM).

- **Logs**: `docker compose -f infra/docker-compose.yml logs -f` (ou `logs -f api`, `livekit`,
  `caddy`).
- **Atualizar o Concord**: `git pull && docker compose -f infra/docker-compose.yml up -d --build`.
  Só o api é reconstruído; o LiveKit e o Caddy só reiniciam se o compose mudou.
- **Atualizar o LiveKit**: mude a tag em `infra/docker-compose.yml` (e mantenha igual em
  `infra/local/start.ps1` e `infra/docker-compose.dev.yml`), leia as notas da release em
  <https://github.com/livekit/livekit/releases> e rode `up -d`. O `infra/livekit.yaml` é
  validado no start: `could not parse config` indica chave desconhecida na versão nova.
- **Adicionar/remover amigo**: edite `infra/users.json` (ou gere no PC e copie com `scp`) e
  rode `docker compose -f infra/docker-compose.yml restart api`. O api recarrega o arquivo
  sozinho quando ele é editado no lugar, mas editores que gravam um arquivo novo (e `scp`)
  trocam o inode e o container continua vendo o antigo — o `restart` resolve sempre.
- **Mudar o `.env`** (salas, segredo, domínio): `docker compose -f infra/docker-compose.yml up -d`
  recria só os containers afetados.
- **Backup**: `infra/.env` e `infra/users.json` (fora do git). Os certificados ficam no volume
  `concord_caddy_data`; não precisa de backup (o Caddy re-emite), mas não apague o volume à toa:
  o Let's Encrypt limita a 5 certificados iguais por semana.
- **Parar o Concord**: `docker compose -f infra/docker-compose.yml down` (mantém os volumes);
  `up -d` de novo para voltar. Com `restart: unless-stopped`, os containers voltam sozinhos
  quando a VM reinicia.

## 9. Ociosidade (Always Free)

A Oracle pode recuperar VMs Always Free que passem **7 dias** com CPU, rede e memória abaixo
de 20% de uso. O Minecraft normalmente já evita isso; sem ele, contas convertidas para
_Pay As You Go_ (mesmo sem gastar nada) não sofrem essa regra.

## 10. Problemas comuns

| Sintoma                                                      | Onde olhar / o que fazer                                                                                                                                                           |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `caddy` repete erros ACME / `https://` não responde          | DNS ainda não aponta para a VM (`nslookup`); TCP 80/443 fechados na Security List ou no iptables (seção 3/4). Teste `curl -I http://<domínio>` de fora.                            |
| `/api/health` ok, mas o app não conecta ao LiveKit           | `logs livekit` sem o IP público em `using external IPs`; TCP 7881 / UDP 50000–50200 fechados. O connection-test da seção 6 aponta qual etapa falha.                                |
| Presença vazia no app (ninguém aparece na sidebar)           | O webhook não chega ao api: `logs livekit \| grep -i webhook`; `sudo ss -tlnp \| grep 3000` tem que mostrar `127.0.0.1:3000`; `LIVEKIT_API_KEY=concord` igual a `webhook.api_key`. |
| `api` fica `unhealthy` / reinicia                            | `logs api`: `configuração inválida` (variável faltando no `.env`), `arquivo de usuários não encontrado` (`infra/users.json` ausente ou sem permissão de leitura, seção 5.4).       |
| Build falha com `ERR_PNPM_OUTDATED_LOCKFILE`                 | O `pnpm-lock.yaml` está defasado em relação aos `package.json`: no PC, `pnpm install`, commit do lockfile, `git pull` na VM.                                                       |
| Build falha em `corepack` (`Cannot find matching keyid`)     | Imagem base antiga: `docker pull node:22-alpine` e repita o build (ver comentário no Dockerfile).                                                                                  |
| `docker compose` reclama de `ports` com `network_mode: host` | Versão antiga do Compose; é preciso o plugin v2 (`docker compose version`). Os serviços `livekit` e `caddy` não têm `ports` de propósito.                                          |
| Minecraft lento/travando depois do deploy                    | `docker stats`: se `livekit` bate em 1 CPU com várias transmissões, reduza os presets no app ou o número de streams; os limites do compose protegem o resto da VM, mas não a rede. |

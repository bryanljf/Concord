# Hospedar o Telão no seu próprio PC (Windows)

Esta é a alternativa à VM da Oracle (Fase 5): o servidor do Telão (`livekit-server` + `api`)
roda no **seu PC**, sem Docker. Serve bem para um grupo de ~10 amigos **se** a sua internet
tiver upload suficiente (veja [Upload](#upload-a-conta-que-importa)) e o provedor te der um
IP público (veja [CGNAT](#cgnat-quando-o-provedor-não-dá-ip-público)).

Tudo que dá para automatizar está em `infra/local/start.ps1`; este documento explica o que o
script não consegue fazer por você (roteador, DuckDNS, provedor) e como testar.

## Requisitos

- Windows 10 ou 11 (64 bits). O script roda no Windows PowerShell 5.1, que já vem instalado.
- [Node.js](https://nodejs.org) 22 ou mais novo e [pnpm](https://pnpm.io) (`npm install -g pnpm`).
- Git (para clonar o repositório).
- Internet com **upload alto** (fibra), de preferência com **IP público** no roteador.
- Acesso ao painel do seu roteador (para o port forwarding).
- O PC precisa **ficar ligado** enquanto o pessoal usa o Telão.

## Passo a passo

1. Clonar e instalar:

   ```powershell
   git clone <url-do-repositorio> Telao
   cd Telao
   pnpm install
   ```

2. Criar o `infra/.env`. Rode o script uma vez; ele copia `infra/.env.example` para `infra/.env`
   e pergunta se pode ativar o bloco "Hospedagem local", gerar o `LIVEKIT_API_SECRET` e
   preencher seu IP público:

   ```powershell
   powershell -ExecutionPolicy Bypass -File infra\local\start.ps1
   ```

   Abra `infra/.env` e confira. Se você tiver DuckDNS (recomendado, veja abaixo), troque o IP
   em `LIVEKIT_URL` pelo seu nome: `LIVEKIT_URL=ws://seunome.duckdns.org:7880`. As salas ficam
   em `ROOMS=geral` (ex.: `ROOMS=geral,jogos,filme`).

3. Criar um usuário para cada amigo (e para você). O comando imprime a **chave de acesso** que a
   pessoa digita no app, junto com a URL do servidor:

   ```powershell
   pnpm --filter @telao/api user:add bryan Bryan
   pnpm --filter @telao/api user:add joao João
   ```

   As chaves ficam em `infra/users.json` (fora do git). Para revogar alguém, apague a entrada;
   o api recarrega o arquivo sozinho em alguns segundos.

4. Subir o servidor:

   ```powershell
   powershell -ExecutionPolicy Bypass -File infra\local\start.ps1
   ```

   Na primeira vez o script baixa o `livekit-server` v1.13.9 (~19 MB) para `infra/local/bin/`
   e confere o SHA256 com o `checksums.txt` da release (se não bater, ele descarta o arquivo e
   para). Depois abre duas janelas, **"Telao - LiveKit"** e **"Telao - api"**, espera as duas
   responderem e imprime a URL que os amigos devem digitar no app, a tabela de port forwarding
   e os avisos pendentes (firewall, `LIVEKIT_URL` x IP público).

5. Liberar o Firewall do Windows (uma vez, como administrador):

   ```powershell
   powershell -ExecutionPolicy Bypass -File infra\local\start.ps1 -Firewall
   ```

   Se você não estiver como administrador, o script explica e se oferece para abrir a janela
   elevada. Ele cria três regras de entrada chamadas `Telao ...` (TCP 3000; TCP 7880 e 7881;
   UDP 50000–50200). Se o Windows mostrar o aviso "Permitir acesso" do `livekit-server.exe`
   ou do `node.exe`, marque redes **privadas e públicas** e permita.

6. Configurar o port forwarding no roteador (abaixo) e, se o seu IP muda, o DuckDNS.

7. Testar (seção [Como testar](#como-testar)) e mandar para os amigos a URL
   `http://<seu-ip-ou-duckdns>:3000` + a chave de cada um.

Para parar tudo: `powershell -ExecutionPolicy Bypass -File infra\local\start.ps1 -Stop`.

## Port forwarding no roteador

O roteador precisa encaminhar estas portas para o **IP do seu PC na rede local**:

| Protocolo | Porta(s)      | Serviço                                       |
| --------- | ------------- | --------------------------------------------- |
| TCP       | 3000          | api (login, tokens, presença)                 |
| TCP       | 7880          | LiveKit: sinalização (WebSocket)              |
| TCP       | 7881          | LiveKit: ICE sobre TCP (quando o UDP não vai) |
| UDP       | 50000 a 50200 | LiveKit: mídia (vídeo/áudio)                  |

No painel do roteador isso costuma se chamar "Port Forwarding", "Redirecionamento de portas",
"Virtual Server" ou "NAT". Para cada linha: porta externa = porta interna, protocolo da tabela,
IP de destino = o IP do seu PC na LAN. Alguns painéis aceitam faixa (`50000-50200`); outros
pedem "porta inicial" e "porta final".

**IP do PC na LAN**: o `start.ps1` imprime no resumo final ("IP deste PC na rede local"). Ou
rode `ipconfig` e use o "Endereço IPv4" do adaptador em uso (algo como `192.168.0.x` ou
`192.168.15.x`). Como esse IP pode mudar quando o PC reinicia, configure no roteador uma
**reserva de DHCP** (ou "IP estático por MAC") para o seu PC, senão o port forwarding para
de funcionar um dia.

## IP público dinâmico + DuckDNS

A maioria dos provedores troca o seu IP público de tempos em tempos. Se os amigos usarem o IP
direto, a URL deles quebra quando isso acontece. Solução grátis: um nome fixo no
[DuckDNS](https://www.duckdns.org) que aponta sempre para o IP atual.

1. Entre no DuckDNS (login com GitHub/Google), crie um subdomínio (ex.: `telao`) e anote o
   **token** da sua conta.
2. Use o nome no `infra/.env`: `LIVEKIT_URL=ws://telao.duckdns.org:7880`, e passe para os amigos
   `http://telao.duckdns.org:3000`.
3. Mantenha o IP atualizado. A URL de atualização do DuckDNS é
   `https://www.duckdns.org/update?domains=SEUNOME&token=SEUTOKEN&ip=` (com `ip=` vazio, ele
   usa o IP de quem chamou). Crie uma tarefa agendada que chama essa URL a cada 5 minutos
   (PowerShell normal, troque `SEUNOME` e `SEUTOKEN`):

   ```powershell
   $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -WindowStyle Hidden -Command "Invoke-WebRequest -UseBasicParsing ''https://www.duckdns.org/update?domains=SEUNOME&token=SEUTOKEN&ip='' | Out-Null"'
   $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)
   Register-ScheduledTask -TaskName 'Telao DuckDNS' -Action $action -Trigger $trigger -Description 'Atualiza o IP publico no DuckDNS'
   ```

   Para conferir: `Start-ScheduledTask -TaskName 'Telao DuckDNS'` e depois `nslookup telao.duckdns.org`
   deve mostrar o mesmo IP de <https://api.ipify.org>. O `start.ps1` também avisa se
   `LIVEKIT_URL` não bate com o IP público do momento.

## CGNAT: quando o provedor não dá IP público

Muitos provedores brasileiros (principalmente em fibra "popular" e em planos novos) colocam o
cliente atrás de **CGNAT**: vários clientes dividem um mesmo IPv4 público e **nenhum port
forwarding funciona**, porque o roteador do provedor não encaminha nada para você.

Como identificar:

- Abra o painel do seu roteador e veja o **IP WAN** (status / internet). Se ele estiver entre
  `100.64.0.0` e `100.127.255.255`, é CGNAT. Se estiver em `10.x.x.x`, `172.16-31.x.x` ou
  `192.168.x.x`, há outro roteador/modem do provedor na frente (NAT duplo).
- Compare o IP WAN com o "meu IP" de <https://api.ipify.org>. Se forem **diferentes**, existe
  NAT antes de você e o port forwarding no seu roteador não vai adiantar.
- Teste prático: com tudo rodando e as portas encaminhadas, peça para alguém de fora (ou
  use o 4G do celular) abrir `http://<seu-ip-publico>:7880/`. Tem que aparecer `OK`.

O que fazer:

1. **Pedir IP público ao provedor.** Muitos liberam na hora (às vezes chamam de "IP fixo" ou
   "abrir CGNAT"; alguns cobram uma taxa pequena). É a solução mais simples.
2. **NAT duplo** (modem do provedor em modo roteador na frente do seu): coloque o modem em
   **modo bridge** ou faça o port forwarding também nele (apontando para o seu roteador).
3. **IPv6**: quase todo provedor entrega IPv6 público, sem NAT. Funciona se **todos os amigos**
   também tiverem IPv6. Você precisaria liberar as mesmas portas no firewall IPv6 do roteador
   (normalmente fechado por padrão) e usar o endereço entre colchetes nas URLs
   (`LIVEKIT_URL=ws://[2804:...]:7880`; o DuckDNS aceita IPv6 pelo parâmetro `&ipv6=`). É mais
   chato de manter; só vale se o item 1 falhar.
4. **Usar a opção Oracle** (Fase 5): a VM tem IP público de verdade e TLS; só muda onde o
   servidor roda.

## Upload: a conta que importa

O LiveKit é um SFU: ele **não mistura nem recomprime** nada, mas envia **uma cópia da stream
para cada espectador**. O upload que o seu PC precisa é, aproximadamente:

> upload ≈ bitrate da stream × número de espectadores (× número de streams simultâneas)

A stream de quem transmite chega ao servidor em download (barato); o que pesa é a saída.
Com o preset "Jogo" do app (1080p60, até 6 Mbps):

| Cenário                                                 | Upload necessário |
| ------------------------------------------------------- | ----------------- |
| 1 stream de 6 Mbps, 4 espectadores                      | ~24 Mbps          |
| 1 stream de 6 Mbps, 9 espectadores                      | ~54 Mbps          |
| 3 streams de 6 Mbps, 10 pessoas (todo mundo vendo tudo) | ~162 Mbps         |

Conte uns 20% a mais para cabeçalhos e retransmissões. Se quem transmite for você mesmo (no
PC que hospeda), essa stream não gasta upload para entrar, mas gasta para sair igual às outras.

Recomendação: **fibra com upload de 100 Mbps ou mais** (planos "simétricos" de 200/300 Mbps
estão ótimos; 500/50 Mbps não). Com menos que isso, use os presets "Padrão" (4 Mbps) ou "Leve"
(2,5 Mbps) e evite várias transmissões ao mesmo tempo. O simulcast do LiveKit reduz a
qualidade para quem está com conexão ruim, mas não reduz o total de cópias.

Meça o seu upload em <https://www.speedtest.net> (número "Upload").

## Firewall, energia e outros detalhes

- **Firewall do Windows**: as regras `Telao ...` (passo 5). Antivírus de terceiros com firewall
  próprio também precisam liberar as mesmas portas.
- **O PC precisa ficar ligado** e sem dormir: Configurações > Sistema > Energia > Tela e
  suspensão > "Nunca" para suspensão quando ligado na tomada (ou
  `powercfg /change standby-timeout-ac 0`). Reiniciar o Windows derruba o servidor (rode o
  `start.ps1` de novo).
- **Sem TLS (ws:// e http://)**: na hospedagem local não existe certificado, então os amigos
  usam `http://...:3000` e o LiveKit `ws://...:7880`. Isso é aceitável aqui porque **só o app
  Electron do Telão** se conecta (ele aceita `ws://`; navegadores exigiriam `wss://`). A mídia
  WebRTC em si é sempre criptografada (DTLS-SRTP); só a sinalização e as chamadas ao api vão em
  texto. A chave de acesso de cada amigo viaja nessas chamadas, então não use em redes públicas
  hostis. Se quiser TLS, use a opção Oracle (Caddy cuida de tudo) ou habilite TURN/TLS no
  `livekit.yaml` (comentado lá; exige certificado para um domínio).
- **Quem hospeda** usa `http://127.0.0.1:3000` no próprio app: o api devolve
  `LIVEKIT_LOCAL_URL` (`ws://127.0.0.1:7880`) para conexões vindas do próprio PC, e o
  `livekit.yaml` anuncia também o IP da LAN (`advertise_internal_ip`), então nada depende de o
  roteador fazer "NAT loopback".
- `infra/livekit.yaml` tem `skip_external_ip_validation: true` de propósito: atrás de roteador
  doméstico o auto-teste do LiveKit falha (o roteador não devolve o pacote para o próprio IP) e,
  sem isso, ele desistiria do IP público e ninguém de fora conectaria.

## Como testar

Com o `start.ps1` no ar:

1. **Health do api**: <http://127.0.0.1:3000/api/health> tem que responder `{"ok":true}`.
   `http://127.0.0.1:7880/` responde `OK` (o LiveKit).
2. **Logs do LiveKit**: na janela "Telao - LiveKit" (cópia em `infra/local/livekit.log`) deve
   aparecer `starting LiveKit server {"portHttp": 7880, ... "version": "1.13.9", "rtc.portTCP": 7881, "rtc.portICERange": [50000, 50200]}`
   e `using external IPs {"ips": ["SEU-IP-PUBLICO/192.168.x.x", ...], "advertiseInternalIP": true}`.
   Duas linhas que aparecem **sempre no Windows** e não são problema: `ERROR ... CPU monitoring
unsupported on current platform` (com uma pilha de chamadas embaixo) e `Windows detected,
capacity management is unavailable`. Se o `.env` estiver sem segredo o LiveKit nem sobe
   (`one of key-file or keys must be provided`), e `could not parse config` indica erro no yaml.
3. **De fora**: peça a um amigo (ou use o 4G do celular, fora do Wi-Fi) para abrir
   `http://<seu-ip-ou-duckdns>:3000/api/health` e `http://<seu-ip-ou-duckdns>:7880/`. Se o
   primeiro falha, é port forwarding/firewall/CGNAT da porta 3000; o segundo, da 7880.
4. **Conexão WebRTC completa** (<https://livekit.io/connection-test>): gere um token pelo api,
   com a chave de um usuário (no PowerShell use `curl.exe`, não `curl`):

   ```powershell
   curl.exe -s -X POST http://127.0.0.1:3000/api/token -H "Authorization: Bearer SUA-CHAVE" -H "Content-Type: application/json" -d "{\"room\":\"geral\"}"
   ```

   A resposta traz `token` e `url`. Na página de teste informe a URL do LiveKit e o token e
   rode. Feito **no PC que hospeda**, use `ws://127.0.0.1:7880` (os navegadores deixam uma
   página https falar com `ws://` só para localhost). De outro PC, a página não aceita `ws://`
   (conteúdo misto): o teste real de fora é o próprio app do Telão, ou o passo 3 para as
   portas TCP. A mídia UDP só é validada por uma sessão de verdade: se o app conecta mas o
   vídeo não aparece, o problema é a faixa UDP 50000–50200 (roteador ou firewall).

5. **Presença**: com o app de dois usuários conectado, `http://127.0.0.1:3000/api/presence`
   (SSE) mostra os eventos `participant_joined`, `stream_started` etc. Se não mostra nada, o
   webhook do LiveKit não está chegando ao api: confira na janela do LiveKit por erros de
   `webhook` e se `LIVEKIT_API_KEY=telao` no `.env` é igual a `webhook.api_key` no yaml.

## Manutenção

- **Parar**: `start.ps1 -Stop` (mata os processos registrados em `infra/local/.pids`, com os
  filhos). Fechar as janelas também para.
- **Reiniciar após mudar o `.env`**: `-Stop` e depois `start.ps1` de novo. Mudanças no
  `users.json` (`user:add`, remover alguém) o api recarrega sozinho, sem reiniciar.
- **Atualizar o LiveKit**: mude `$LiveKitVersion` no começo do `start.ps1` (e a tag em
  `infra/docker-compose.dev.yml` para manter igual). Na próxima execução o script vê que o
  binário em `infra/local/bin/` é de outra versão, baixa a nova e confere o SHA256. Antes de
  subir de versão, leia as notas da release em <https://github.com/livekit/livekit/releases>.
- **Atualizar o Telão**: `git pull`, `pnpm install`, `-Stop` e `start.ps1`.
- **Backup**: `infra/users.json` e `infra/.env` (os dois estão fora do git).
- **Só o LiveKit** (desenvolvimento): `start.ps1 -LiveKitOnly` e rode o api com `pnpm dev:api`
  em outro terminal (o api lê o mesmo `infra/.env`). Quem prefere Docker Desktop usa
  `infra/docker-compose.dev.yml` em vez do script.
- **Logs**: `infra/local/livekit.log` e `infra/local/api.log` são recriados a cada start.

## Local x Oracle (resumo)

| Critério             | Seu PC (este guia)                                        | Oracle Cloud (Fase 5)                       |
| -------------------- | --------------------------------------------------------- | ------------------------------------------- |
| Custo                | Zero (energia do PC)                                      | Zero (Always Free), conta de um amigo       |
| Upload               | O da sua internet; precisa de fibra com upload alto       | Muito alto (datacenter), 10 TB/mês de saída |
| IP público / CGNAT   | Depende do provedor; pode travar tudo                     | IP público garantido                        |
| TLS                  | Não (ws://, http://), só o app Electron conecta           | Sim (Caddy + Let's Encrypt)                 |
| Disponibilidade      | Só com o seu PC ligado e com o script rodando             | 24/7 (dividindo CPU/RAM com o Minecraft)    |
| Latência             | Ótima para quem está perto de você                        | Boa (região sa-saopaulo-1 / sa-vinhedo-1)   |
| Setup                | Roteador + firewall + DuckDNS, tudo na sua mão            | VCN, iptables, Docker, Caddy, DNS           |
| Carga no PC que joga | O SFU usa CPU/rede do seu PC enquanto você joga/transmite | Nenhuma                                     |
| Quando escolher      | Para testar rápido ou se a sua internet é boa e tem IP    | Para deixar fixo e esquecer, ou se há CGNAT |

# @concord/now-playing

"O que está tocando" nos apps de música (Spotify, por enquanto), lido dos **controles de mídia do
Windows** (System Media Transport Controls, `GlobalSystemMediaTransportControlsSessionManager`):
música, artista, álbum, estado, posição/duração e capa. Não precisa de login no Spotify nem da
Web API (descartada: limite de 5 usuários por app e dono Premium).

## Decisão: `@coooookies/windows-smtc-monitor` (fixado em 1.0.12)

- Rust + napi-rs, MIT, binários prontos por plataforma (`…-win32-x64-msvc` é uma
  `optionalDependency` dele). N-API estável: o mesmo binário carrega no Node e no Electron 44.
- Emite eventos (sessão adicionada/removida, mídia, reprodução, linha do tempo) e entrega a capa
  como `Buffer` (PNG, JPEG ou BMP, conforme o app).
- **Trava a thread que o usa.** Por isso nunca roda no processo principal do Electron: o desktop o
  carrega num `utilityProcess` (`apps/desktop/src/main/now-playing/worker.ts`).

Este pacote é só um adaptador fino: `load()` devolve a classe `SMTCMonitor`, ou `null` fora do
Windows e quando o pacote ou o binário não existem (ele é `optionalDependency`, então
`pnpm install` em outras plataformas não quebra). Os tipos ficam em `index.d.ts`, sem depender do
pacote instalado.

## Como funciona no desktop

```
utilityProcess (out/main/now-playing-worker.js)
  @concord/now-playing → SMTCMonitor
    eventos dos apps de música (debounce 150 ms) + releitura completa a cada 3 s
    filtra pelo AUMID (Spotify.exe / SpotifyAB.SpotifyMusic_…!Spotify)
    capa: sha1 → artId (16 hex), bytes enviados uma vez por artId
        │ process.parentPort.postMessage (snapshots simples)
        ▼
main (src/main/now-playing/service.ts)
  NowPlaying (estado, ms, anúncio, artId), push só em mudança real ou salto > 2 s
  capa → nativeImage (BMP decodificado à mão) → JPEG ≤ 160 px e ≤ 11 KB, LRU de 20
  tasklist a cada 5 s enquanto o app não tem sessão de mídia (está aberto?)
        │ IPC music:status / music:art, push music:status-changed
        ▼
renderer (aba Música, painel, RPC concord.music.art)
```

- O worker só sobe no primeiro `getMusicAppStatus` e fica vivo; se cair, o main o reinicia com
  espera crescente (1 s, 5 s, 15 s, 60 s). Se o módulo não carregar, ele avisa e não é reiniciado.
- A posição é uma foto do instante (`lastUpdatedTime`): quem mostra extrapola enquanto toca.

## Limitações conhecidas

- **Spotify:** a opção "Mostrar sobreposição na área de trabalho ao usar teclas de mídia" precisa
  estar ligada; sem ela, o Spotify para de publicar no Windows depois de alguns segundos. A
  sessão só aparece quando a reprodução começa.
- O Windows às vezes para de emitir eventos: a releitura a cada 3 s cobre isso.
- A capa costuma chegar depois do título; a mesma música mantém a capa anterior se ela sumir
  por um instante.

## Empacotamento

- `electron.vite.config.ts`: `@concord/now-playing` e `@coooookies/windows-smtc-monitor` são
  externos (nunca embutidos no bundle); o worker é a segunda entrada do build do main.
- `electron-builder.yml`: `asarUnpack` de `**/node_modules/@concord/now-playing/**` e
  `**/node_modules/@coooookies/windows-smtc-monitor*/**` (pega também o pacote do binário).
- O electron-builder precisa **detectar o pnpm** (rodar por `pnpm exec electron-builder`, como no
  `release.yml`). Via `npx` ele cai no coletor do npm e deixa de fora o pacote do binário
  (`…-win32-x64-msvc`, dependência opcional de dependência opcional).

## Desenvolvimento

```bash
pnpm --filter @concord/now-playing test        # vitest (módulo simulado)
pnpm --filter @concord/now-playing typecheck
```

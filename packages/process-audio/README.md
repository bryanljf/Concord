# @concord/process-audio

Captura de áudio **por processo** no Windows (SPEC 5.7, Fase 3b): ao transmitir uma janela, só o
som daquele programa vai junto; ao transmitir a tela inteira, vai tudo **menos** a chamada do
Discord. Por baixo é a API _Process Loopback_ do Windows 10 2004+ (`ActivateAudioInterfaceAsync`
com `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`).

## Decisão: usar o addon `loopback-capture` (não compilar um addon próprio)

Esta máquina de desenvolvimento não tem toolchain C++ (sem MSVC, Windows SDK ou Python), então
um addon escrito aqui só poderia ser compilado no GitHub Actions — e o repositório ainda nem tem
remoto. A pesquisa (abaixo) encontrou um pacote npm que já faz exatamente o necessário e traz o
binário pronto; ele foi verificado nesta máquina antes de ser adotado.

| Candidato                                                                                                                          | O que é                                                                                                                                                                                                                 | Veredito                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| [`loopback-capture`](https://www.npmjs.com/package/loopback-capture) 3.0.2 ([repo](https://github.com/WerdoxDev/loopback-capture)) | Addon N-API 9 em C++ (WRL + WIL, cópia fiel do sample da Microsoft) com `prebuilds/win32-x64/*.node` **dentro do pacote npm**; modos include/exclude; PCM 16-bit 48 kHz estéreo via callback; MIT; publicado em 2026-09 | **Escolhido**                                                   |
| [`thomas-quant/wasapi-loopback`](https://github.com/thomas-quant/wasapi-loopback)                                                  | Rust + napi-rs, só modo _exclude_ (feito para o GoofCord), não publicado no npm (dependência via GitHub), 2 commits                                                                                                     | Rejeitado: sem modo _include_                                   |
| [`electron-audio-loopback`](https://www.npmjs.com/package/electron-audio-loopback)                                                 | Usa o loopback do próprio Chromium                                                                                                                                                                                      | Rejeitado: captura o sistema inteiro (é o que a Fase 3a já faz) |
| [`TouMingQAQ/ProcessAudioCapture`](https://github.com/TouMingQAQ/ProcessAudioCapture)                                              | DLL C com ABI própria                                                                                                                                                                                                   | Rejeitado: exigiria FFI ou um addon para embrulhar              |
| [Electron #54628](https://github.com/electron/electron/issues/54628)                                                               | Pedido para expor o loopback por aplicativo do Chromium no `setDisplayMediaRequestHandler`                                                                                                                              | Aberto, sem resposta dos mantenedores (out/2026); acompanhar    |
| Addon próprio (`node-addon-api` + `prebuildify`)                                                                                   | Plano B descrito no fim                                                                                                                                                                                                 | Desnecessário por enquanto                                      |

Referências de implementação lidas: [ApplicationLoopback (Microsoft)](https://github.com/microsoft/Windows-classic-samples/tree/main/Samples/ApplicationLoopback)
e `plugins/win-wasapi/win-wasapi.cpp` do OBS ("Application Audio Capture").

### Verificação feita nesta máquina (Windows 11 build 26200, x64)

- Node 24: o binário carrega; capturando um `powershell.exe` tocando um WAV, o modo _include_
  entregou 275 chunks de 1920 bytes (480 frames = 10 ms cada, 48 kHz estéreo int16) com pico de
  −40 dBFS; o modo _exclude_ do mesmo processo entregou 0 chunks; `pid 0` falha com `E_INVALIDARG`;
  duas capturas simultâneas funcionam; start/stop imediato não trava.
- Electron 44.7.0 (`ELECTRON_RUN_AS_NODE=1`, sem abrir o app): carrega e inicia/para a captura. O
  binário usa o hook de _delay-load_ do cmake-js (`node.exe` → executável atual), então funciona
  dentro do Electron sem recompilar.
- O relato de "silêncio digital" com NAudio nesta mesma build ([MeetCap #38](https://github.com/lybym/MeetCap/issues/38))
  **não** se reproduziu com este addon.

## Como funciona

```
desktopCapturer id ──► apps/desktop/src/main/audio (engine)
   window:<hwnd>:0 ──► PowerShell GetWindowThreadProcessId ──► pid ──► modo include
   screen:<n>:0    ──► PowerShell Get-CimInstance Win32_Process ──► raiz da árvore do Discord ──► modo exclude
                                   │
                                   ▼
                     @concord/process-audio (index.js) ──► loopback-capture (WASAPI Process Loopback)
                                   │  int16 → float32, chunks de 10 ms (só os não silenciosos)
                                   ▼
                     IPC onProcessAudioData ──► renderer: AudioWorklet (jitter buffer ≤ 100 ms)
                                                ──► MediaStreamAudioDestinationNode ──► track
```

- `load()` devolve `null` fora de Windows x64 ou quando o pacote `loopback-capture` não está
  instalado (ele é `optionalDependency`, então `pnpm install` em outras plataformas não quebra).
- `isSupported()` compara a build do Windows (`os.release()`) com 19041 (Windows 10 2004). A
  documentação do header diz build 20348, mas a API existe desde a 2004; em builds antigas o
  `start()` falha com HRESULT e a mensagem chega em pt-BR.
- O engine devolve `ProcessAudioError` com `code` (`unsupported`, `invalid_source`,
  `window_process_unknown`, `discord_not_running`, `native_failure`) e mensagem pt-BR. Com a tela
  inteira e **sem Discord aberto** o engine recusa (`discord_not_running`) em vez de capturar tudo
  por baixo dos panos — o renderer deve cair no loopback do Electron nesse caso.

## Limitações conhecidas

- Só uma árvore de processos pode ser excluída por captura: com Discord e Discord Canary abertos
  ao mesmo tempo, exclui-se a árvore com mais processos.
- Janelas de apps UWP/Store ficam dentro do `ApplicationFrameHost.exe`; o pid obtido é o do host e a
  captura fica muda. Jogos Win32 (a maioria) não têm esse problema.
- O addon não entrega pacotes silenciosos (gate de −70 dBFS) nem avisa quando o dispositivo some;
  o worklet preenche silêncio e o stream continua contínuo.
- Cada `start` custa ~0,4 s por consulta ao PowerShell (pid da janela ou lista do Discord).
- `stop()` do addon bloqueia a thread principal por ~1 ms; o engine garante ≥ 100 ms de captura
  antes de parar (abaixo disso o addon devolve `E_NOT_VALID_STATE` e deixaria a captura órfã).

## Empacotamento (o que o agente do desktop/release precisa fazer)

- `@concord/process-audio` deve continuar **externo** no bundle do main (`electron-vite` já
  externaliza dependências do `package.json`); o engine faz `require('@concord/process-audio')`
  protegido por `try/catch`.
- No instalador precisam existir, dentro de `node_modules`: `@concord/process-audio`,
  `loopback-capture`, `bindings` e `file-uri-to-path`. Com pnpm, o electron-builder só os copia se
  forem alcançáveis a partir de `apps/desktop` (dependência `workspace:*` já está declarada).
- `electron-builder.yml`: `asarUnpack: ["**/loopback-capture/prebuilds/**"]` (o `smartUnpack`
  padrão também desempacota `.node`, mas é melhor ser explícito).
- `release.yml` não compila nada: basta `pnpm install --frozen-lockfile` antes de empacotar. O
  workflow `.github/workflows/native-prebuild.yml` só confere que o binário carrega em Node e no
  Electron num Windows limpo.

## Desenvolvimento

```bash
pnpm --filter @concord/process-audio test        # vitest (addon simulado)
pnpm --filter @concord/process-audio typecheck
node packages/process-audio/scripts/smoke.js    # carrega o binário real e tenta uma captura
```

## Plano B: addon próprio

Se o `loopback-capture` ficar sem manutenção, o caminho é um addon pequeno com `node-addon-api`
(`NAPI_VERSION 8`), `src/addon.cc` seguindo o sample ApplicationLoopback (formato float32 48 kHz
estéreo + `AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM`, thread de captura MTA, `napi_threadsafe_function`
com fila limitada), `binding.gyp` ligando `mmdevapi.lib`/`ole32.lib`, `prebuildify --napi --strip
--arch x64` no `windows-latest` e `node-gyp-build` para carregar `prebuilds/win32-x64/node.napi.node`.
O contrato `index.d.ts` deste pacote já isola o resto do app dessa troca.

# Instalar o Concord

O Concord é o nosso app de compartilhamento de tela: o Discord continua para a voz e o chat; o
Concord só transmite a tela, com o som do jogo. Ele fica na bandeja do Windows e abre uma janela
com visual parecido com o do Discord para assistir ou transmitir.

Requisitos: Windows 10 ou 11 de 64 bits e uma conta Discord **liberada pelo administrador** do
grupo. Não precisa de conta de administrador do Windows.

## 1. Baixar o instalador

1. Abra https://github.com/bryanljf/Concord/releases/latest
2. Em **Assets**, baixe **`Concord-Setup-<versão>.exe`**. Ignore os outros arquivos
   (`latest.yml`, `.blockmap`): eles servem para a atualização automática.
3. Se o navegador avisar que o arquivo "não é baixado com frequência", escolha **Manter** /
   **Manter mesmo assim**.

## 2. O aviso do SmartScreen

Ao abrir o instalador, o Windows mostra **"O Windows protegeu o computador"**. É esperado:

1. Clique em **Mais informações**.
2. Clique em **Executar assim mesmo**.

O aviso aparece para qualquer programa sem certificado de assinatura de código, que é pago e não
compensa para um app de um grupo de amigos. Baixe sempre do link acima, nunca de outro lugar.

## 3. Instalar

A instalação é de um clique: não pergunta nada, não pede senha de administrador e instala só
para o seu usuário (em `%LOCALAPPDATA%\Programs\Concord`). No fim o Concord abre sozinho.

## 4. Primeira vez: entrar com o Discord

1. **Servidor**: cole o endereço que o administrador te passou em particular (ele não vem
   preenchido e não fica publicado em lugar nenhum).
2. **Continuar com Discord**: abre a página oficial do Discord. Com o app do Discord aberto, ele
   pede a confirmação lá mesmo; senão, entre com e-mail e senha ou pelo QR code. Só contas
   liberadas entram; as outras veem "Esta conta não está autorizada".
3. **Preferências**: iniciar com o Windows, abrir junto com o Discord e o atalho para transmitir
   (padrão `Ctrl+Shift+L`). Tudo pode ser mudado depois em **Configurações**.

Seu nome e sua foto vêm do Discord. Para usar outro nome no Concord, clique no seu nome no canto
inferior esquerdo e altere o **Nome de exibição** (o botão **Usar nome do Discord** volta ao
original).

## 5. No dia a dia

- **Salas**: a barra lateral mostra Sala 1, Sala 2 e Sala 3, quem está em cada uma e o selo
  **AO VIVO** de quem está transmitindo. Clique numa sala para entrar; o painel acima do seu
  nome mostra a sala atual e tem o botão de **sair da sala**. O botão **«** ao lado de
  "CONCORD" recolhe a barra numa coluna de ícones (passe o mouse numa sala para ver quem está
  nela); **»** expande de novo.
- **Assistir**: ao entrar numa sala você não recebe vídeo de ninguém até escolher. Cada live (e
  cada câmera ligada) aparece como um cartão com **Assistir** (também dá para clicar no selo AO
  VIVO na barra lateral). Com duas ou mais assistidas, elas ficam lado a lado numa grade, todas
  com som. Clique numa delas para o **destaque**: ela vem em qualidade cheia e com som, e as
  outras ficam em miniatura embaixo, sem som. O botão de grade (ou `Esc`) volta para a grade.
- **Clique com o botão direito** numa live para **Colocar em destaque**, **Voltar para a
  grade**, **Abrir em pop-out**, **Silenciar**, **Estatísticas da transmissão** ou **Parar de
  assistir**. No pop-out a live sai da janela principal (fica um aviso no lugar) e volta com
  **Trazer de volta**.
- **Volume**: cada live começa em 50%; o controle vai de 0 a 100%. `M` silencia a live em
  destaque, `F11` ou duplo clique abre a tela cheia e `Esc` sai dela.
- **Câmera**: botão **Câmera** na barra de baixo (a setinha ao lado escolhe o dispositivo; o
  teste fica em **Configurações → Câmera**). Se o Windows bloquear, libere em **Configurações do
  Windows → Privacidade e segurança → Câmera → Permitir que aplicativos da área de trabalho
  acessem a câmera**.
- **Picture-in-picture**: no botão direito de uma câmera, **Abrir câmeras em
  picture-in-picture** mostra todas as câmeras que você assiste numa janelinha no canto superior
  direito, por cima dos outros programas. Arraste para mover, puxe um canto para mudar o tamanho
  e use o botão direito nela para tela cheia, disposição ou para deixá-la de ficar por cima de
  tudo. Jogos em **tela cheia exclusiva** ficam por cima dela: use **tela cheia sem bordas**. Ela
  não aparece nas suas transmissões nem em capturas de tela.
- **Música**: para transmitir o seu Spotify, abra **Transmitir → Música** com o Spotify tocando.
  Dá para transmitir só a música ou junto com a tela. Para ouvir a música de alguém, clique no
  ícone de **fone** ao lado do número de pessoas da sala e em **Ouvir** (uma música por vez). Se a
  música não aparecer, ative no Spotify **Configurações → Exibir sobreposição na área de trabalho
  ao usar as teclas de mídia**. Transmitindo a **tela inteira** com áudio, o Spotify também vai no
  áudio da tela; quem ouve pode silenciar um dos dois.
- **Transmitir**: botão **Transmitir**, item **Transmitir…** da bandeja ou o atalho. Escolha uma
  janela (só aquele programa) ou uma tela inteira e a qualidade (Leve 720p30, Padrão 1080p30 ou
  Jogo 1080p60). O **áudio do aplicativo** vai junto **sem a call do Discord**. Durante a live o
  mesmo botão vira **Trocar fonte**: troca a janela ou a tela sem derrubar quem está assistindo.
- **Som de aviso**: quando alguém entra ao vivo **na sala em que você está**, toca um som curto.
  Em **Configurações → Sons** dá para silenciar salas ou pessoas.
- **Fechar a janela (X) não fecha o app**: ele continua na bandeja, gastando quase nada. Para
  sair de verdade, use **Sair** no menu da bandeja (botão direito no ícone perto do relógio).

## 6. Atualizações automáticas

O Concord verifica atualizações ao abrir e de hora em hora e baixa em segundo plano. Quando uma
versão nova estiver pronta, aparece um aviso do Windows, um item **Reiniciar para atualizar** na
bandeja e uma faixa no topo com **Reiniciar agora**. Se preferir, ela é instalada sozinha na
próxima vez que você sair do app. Não precisa desinstalar nada para atualizar.

## 7. Desinstalar

**Configurações do Windows → Aplicativos → Aplicativos instalados → Concord → Desinstalar**.
Para apagar também suas preferências e o login, exclua a pasta `%APPDATA%\Concord` depois.

## Problemas comuns

| O que aparece                             | O que fazer                                                                                                 |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| "Esta conta não está autorizada"          | Sua conta Discord ainda não foi liberada: mande o seu ID do Discord para o administrador.                   |
| "Não foi possível conectar ao servidor …" | Confira se o endereço do servidor é o que o administrador passou e avise-o se continuar.                    |
| Não ouço uma live                         | No destaque só a live destacada tem som: clique na miniatura dela. Confira também o volume e o mudo.        |
| Uma live trava ou perde quadros           | Botão direito nela → **Estatísticas da transmissão** → **Copiar diagnóstico** e mande para o administrador. |
| A atualização não chega                   | Saia pelo menu da bandeja e abra de novo; se persistir, baixe o instalador mais novo e rode por cima.       |

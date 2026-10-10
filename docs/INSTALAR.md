# Instalar o Concord

O Concord é o nosso app de compartilhamento de tela: o Discord continua para a voz e o chat; o
Concord só transmite a tela (com o som do jogo). Ele fica na bandeja do Windows, avisa quando
alguém entra ao vivo e abre uma janela para assistir ou transmitir.

Você vai precisar de duas coisas que **quem hospeda o servidor** te envia:

- a **URL do servidor** (algo como `http://meu-ip:3000` ou `https://concord.exemplo.com`);
- a sua **chave de acesso** (uma sequência longa de letras e números, só sua).

Requisitos: Windows 10 ou 11 de 64 bits. Não precisa de conta de administrador.

## 1. Baixar o instalador

1. Abra a página de versões do projeto: `https://github.com/bryanljf/Concord/releases/latest`
   (quem hospeda te passa o link certo).
2. Em **Assets**, baixe o arquivo **`Concord-Setup-<versão>.exe`** (por exemplo
   `Concord-Setup-0.1.0.exe`). Ignore os outros arquivos (`latest.yml`, `.blockmap`): eles
   servem para a atualização automática.
3. Se o navegador perguntar se quer manter o arquivo (Edge/Chrome às vezes avisam que "não é
   baixado com frequência"), escolha **Manter** / **Manter mesmo assim**.

## 2. O aviso do SmartScreen

Ao abrir o instalador, o Windows mostra uma tela azul **"O Windows protegeu o computador"**.
Isso é esperado. Para continuar:

1. Clique em **Mais informações** (o link pequeno abaixo do texto).
2. Clique no botão **Executar assim mesmo** que aparece.

**Por que aparece?** O Windows mostra esse aviso para qualquer programa que não tenha um
certificado de assinatura de código, que é pago e não faz sentido para um app usado por meia
dúzia de amigos. O instalador vem direto do nosso GitHub; baixe sempre de lá, nunca de outro
lugar.

## 3. Instalar

A instalação é de um clique: não pergunta nada, não pede senha de administrador e instala só
para o seu usuário (em `%LOCALAPPDATA%\Programs\Concord`). No fim, o Concord abre sozinho e
cria um atalho no menu Iniciar e na área de trabalho.

## 4. Primeira vez: conectar ao servidor

Na primeira abertura o app pede:

1. **URL do servidor** — cole exatamente o que quem hospeda te mandou.
2. **Chave de acesso** — cole a sua chave. Se estiver certa, aparece "Olá, _seu nome_!".
3. **Preferências** — iniciar com o Windows (recomendado), abrir junto com o Discord
   (recomendado) e o atalho para transmitir (padrão `Ctrl+Shift+L`). Tudo isso pode ser
   mudado depois em **Configurações**.

Pronto. A partir daí não precisa digitar mais nada: a chave fica guardada de forma
criptografada no seu usuário do Windows.

## 5. Como ele funciona no dia a dia

- **Bandeja**: o ícone perto do relógio mostra o estado — azul (conectado), vermelho (alguém
  ao vivo) ou cinza (desconectado). Clique nele para abrir ou esconder a janela; clique com o
  botão direito para o menu (**Abrir Concord**, **Transmitir…**, **Parar transmissão**,
  **Configurações**, **Sair**).
- **Fechar a janela (X) não fecha o app**: ele continua na bandeja, consumindo quase nada,
  para avisar quando alguém começar a transmitir. Para sair de verdade, use **Sair** no menu da
  bandeja.
- **Iniciar com o Windows**: o app abre escondido na bandeja. Com **Abrir junto com o
  Discord** ligado, ele só se conecta ao servidor enquanto o Discord estiver aberto.
- **Avisos**: quando um amigo entra ao vivo, aparece uma notificação do Windows; clicar nela
  abre a janela já na transmissão.
- **Transmitir**: botão **Transmitir** na janela, item **Transmitir…** da bandeja ou o atalho.
  Escolha uma janela (só o jogo) ou uma tela inteira, a qualidade, e pronto. A opção
  "Incluir áudio do sistema" vem desligada: ligada, ela captura **tudo** que toca no PC,
  inclusive a call do Discord, então use fone de ouvido se ligar.

## 6. Atualizações automáticas

Não precisa baixar versões novas na mão. O Concord verifica se há atualização ao abrir e a
cada 6 horas, baixa em segundo plano e instala sozinho na próxima vez que você sair do app.
Em **Configurações → Verificar atualizações** dá para conferir na hora e usar **Reiniciar para
atualizar** quando uma versão já estiver baixada.

## 7. Desinstalar

**Configurações do Windows → Aplicativos → Aplicativos instalados → Concord → Desinstalar**
(ou pelo "Adicionar ou remover programas"). Para apagar também a configuração e a chave, exclua
a pasta `%APPDATA%\Concord` depois de desinstalar.

## Problemas comuns

| O que aparece                             | O que fazer                                                                                           |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| "Não foi possível conectar ao servidor …" | Confira a URL (com `http://` ou `https://` e a porta) e pergunte se o servidor está no ar.            |
| "Chave de acesso inválida"                | A chave foi digitada errada ou trocada: peça uma nova para quem hospeda.                              |
| Não recebo avisos de transmissão          | O app precisa estar aberto (na bandeja basta) e as notificações do Windows habilitadas para ele.      |
| A atualização não acontece                | Saia pelo menu da bandeja e abra de novo; se persistir, baixe o instalador mais novo e rode por cima. |

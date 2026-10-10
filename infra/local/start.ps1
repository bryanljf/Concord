<#
.SYNOPSIS
    Sobe (ou para) o servidor do Telão neste PC Windows, sem Docker: livekit-server + api.

.DESCRIPTION
    Uso (no PowerShell, de qualquer pasta):

        powershell -ExecutionPolicy Bypass -File infra\local\start.ps1

    Switches:
        -LiveKitOnly  sobe só o livekit-server (para quem roda o api com `pnpm dev:api`).
        -Stop         para os processos iniciados por este script (PIDs em infra\local\.pids).
        -Firewall     cria as regras de entrada no Firewall do Windows (precisa de administrador).

    Na primeira execução cria infra\.env a partir de infra\.env.example e baixa o
    livekit-server (versão fixada em $LiveKitVersion, abaixo) para infra\local\bin\,
    conferindo o SHA256 com o checksums.txt da release. Passo a passo completo (roteador,
    DuckDNS, CGNAT, upload): infra\local\README-local.md

    Compatível com Windows PowerShell 5.1 (o que vem no Windows 10/11) e PowerShell 7.
    Arquivo salvo em UTF-8 com BOM de propósito: sem o BOM o PowerShell 5.1 estraga os acentos.
#>
[CmdletBinding()]
param(
    [switch]$LiveKitOnly,
    [switch]$Stop,
    [switch]$Firewall
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

# ----------------------------------------------------------------------------
# Constantes. Para atualizar o LiveKit: mude a versão aqui e rode o script de novo
# (ele apaga o binário antigo e baixa o novo, conferindo o SHA256).
# ----------------------------------------------------------------------------
$LiveKitVersion = '1.13.9'
$LiveKitZipName = "livekit_${LiveKitVersion}_windows_amd64.zip"
$LiveKitBaseUrl = "https://github.com/livekit/livekit/releases/download/v${LiveKitVersion}"
$ApiPort = 3000
$LiveKitPort = 7880
$LiveKitTcpPort = 7881
$UdpRangeStart = 50000
$UdpRangeEnd = 50200
$HealthTimeoutSeconds = 40

$LocalDir = $PSScriptRoot
$InfraDir = Split-Path -Parent $LocalDir
$RepoRoot = Split-Path -Parent $InfraDir
$EnvFile = Join-Path $InfraDir '.env'
$EnvExample = Join-Path $InfraDir '.env.example'
$LiveKitConfig = Join-Path $InfraDir 'livekit.yaml'
$UsersFile = Join-Path $InfraDir 'users.json'
$BinDir = Join-Path $LocalDir 'bin'
$LiveKitExe = Join-Path $BinDir 'livekit-server.exe'
$PidsFile = Join-Path $LocalDir '.pids'
$LiveKitLog = Join-Path $LocalDir 'livekit.log'
$ApiLog = Join-Path $LocalDir 'api.log'
$ScriptCommand = "powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`""

# ----------------------------------------------------------------------------
# Saída
# ----------------------------------------------------------------------------
function Write-Step([string]$Message) { Write-Host ''; Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok([string]$Message) { Write-Host "    OK    $Message" -ForegroundColor Green }
function Write-Warn([string]$Message) { Write-Host "    AVISO $Message" -ForegroundColor Yellow }
function Write-Fail([string]$Message) { Write-Host "    ERRO  $Message" -ForegroundColor Red }
function Write-Info([string]$Message) { Write-Host "    $Message" }

# Pergunta sim/não. Enter = sim (ou = não, com -DefaultNo). Sem console (stdin fechado) = não.
function Confirm-Choice([string]$Question, [switch]$DefaultNo) {
    $hint = '[S/n]'
    if ($DefaultNo) { $hint = '[s/N]' }
    try {
        $answer = Read-Host "$Question $hint"
    } catch {
        return $false
    }
    if ($null -eq $answer) { return $false }
    if ($answer -eq '') { return (-not $DefaultNo) }
    return ($answer -match '^[sSyY]')
}

# ----------------------------------------------------------------------------
# Utilitários
# ----------------------------------------------------------------------------
function Test-IsElevated {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# 32 bytes aleatórios (CSPRNG) em hexadecimal = 64 caracteres.
function New-Secret {
    $bytes = New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    return (-join ($bytes | ForEach-Object { $_.ToString('x2') }))
}

# Lê um arquivo .env: ignora linhas vazias e comentários, aceita "export X=", tira aspas.
function Read-EnvFile([string]$Path) {
    $vars = [ordered]@{}
    foreach ($raw in [IO.File]::ReadAllLines($Path)) {
        $line = $raw.Trim()
        if ($line -eq '' -or $line.StartsWith('#')) { continue }
        if ($line.StartsWith('export ')) { $line = $line.Substring(7).Trim() }
        $idx = $line.IndexOf('=')
        if ($idx -lt 1) { continue }
        $name = $line.Substring(0, $idx).Trim()
        $value = $line.Substring($idx + 1).Trim()
        if ($value.Length -ge 2) {
            $first = $value.Substring(0, 1)
            $last = $value.Substring($value.Length - 1)
            if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
                $value = $value.Substring(1, $value.Length - 2)
            }
        }
        $vars[$name] = $value
    }
    return $vars
}

function Get-EnvValue($Vars, [string]$Name) {
    if ($Vars.Contains($Name)) { return [string]$Vars[$Name] }
    return ''
}

function Get-PublicIp {
    foreach ($url in @('https://api.ipify.org', 'https://ifconfig.me/ip')) {
        try {
            $ip = (Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 6).Content.Trim()
            if ($ip -match '^\d{1,3}(\.\d{1,3}){3}$') { return $ip }
        } catch { }
    }
    return $null
}

# IPv4 da interface que tem a rota padrão (= o IP que vai no port forwarding do roteador).
function Get-LanIp {
    try {
        $route = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction Stop |
            Sort-Object -Property RouteMetric, InterfaceMetric | Select-Object -First 1
        $address = Get-NetIPAddress -InterfaceIndex $route.InterfaceIndex -AddressFamily IPv4 -ErrorAction Stop |
            Select-Object -First 1
        return $address.IPAddress
    } catch {
        return $null
    }
}

function Get-ListeningProcess([int]$Port) {
    $conn = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $conn) { return $null }
    $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
    if ($proc) { return "$($proc.ProcessName) (PID $($proc.Id))" }
    return "PID $($conn.OwningProcess)"
}

# ----------------------------------------------------------------------------
# livekit-server: download fixado + SHA256
# ----------------------------------------------------------------------------
function Get-LiveKitVersionString {
    try { return (((& $LiveKitExe --version) | Out-String).Trim()) } catch { return '' }
}

function Install-LiveKit {
    $versionPattern = "\b$([regex]::Escape($LiveKitVersion))\b"
    if (Test-Path -LiteralPath $LiveKitExe) {
        $current = Get-LiveKitVersionString
        if ($current -match $versionPattern) {
            Write-Ok "$current já está em $LiveKitExe"
            return
        }
        Write-Warn "binário em $LiveKitExe reporta '$current', esperado $LiveKitVersion; baixando de novo."
        Remove-Item -LiteralPath $LiveKitExe -Force
    }

    New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
    # Pasta nova e vazia só para este download (descartada no fim).
    $work = Join-Path $BinDir ('download-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $work | Out-Null
    try {
        $zip = Join-Path $work $LiveKitZipName
        $sums = Join-Path $work 'checksums.txt'
        Write-Step "Baixando $LiveKitZipName (~19 MB) de $LiveKitBaseUrl"
        Invoke-WebRequest -Uri "$LiveKitBaseUrl/$LiveKitZipName" -OutFile $zip -UseBasicParsing
        Invoke-WebRequest -Uri "$LiveKitBaseUrl/checksums.txt" -OutFile $sums -UseBasicParsing

        $expected = $null
        $entryPattern = "^([0-9a-fA-F]{64})\s+\*?$([regex]::Escape($LiveKitZipName))\s*$"
        foreach ($line in [IO.File]::ReadAllLines($sums)) {
            if ($line -match $entryPattern) { $expected = $Matches[1].ToLowerInvariant() }
        }
        if (-not $expected) { throw "checksums.txt da release não tem uma entrada para $LiveKitZipName" }
        $actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne $expected) {
            throw ("SHA256 NÃO CONFERE para ${LiveKitZipName}!`n" +
                "      esperado (checksums.txt): $expected`n" +
                "      obtido (arquivo baixado):  $actual`n" +
                "    O download foi descartado. Tente de novo; se persistir, NÃO use esse arquivo.")
        }
        Write-Ok "SHA256 confere: $expected"

        $extract = Join-Path $work 'extract'
        Expand-Archive -LiteralPath $zip -DestinationPath $extract -Force
        $exe = Get-ChildItem -LiteralPath $extract -Recurse -Filter 'livekit-server.exe' | Select-Object -First 1
        if (-not $exe) { throw "livekit-server.exe não encontrado dentro de $LiveKitZipName" }
        Move-Item -LiteralPath $exe.FullName -Destination $LiveKitExe -Force
        Unblock-File -LiteralPath $LiveKitExe -ErrorAction SilentlyContinue

        $current = Get-LiveKitVersionString
        if ($current -notmatch $versionPattern) { throw "o binário baixado reporta '$current', esperado $LiveKitVersion" }
        Write-Ok "$current instalado em $LiveKitExe"
    } finally {
        Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# ----------------------------------------------------------------------------
# infra\.env
# ----------------------------------------------------------------------------
function Initialize-EnvFile {
    Write-Step 'infra\.env não existe: criando a partir de infra\.env.example'
    Copy-Item -LiteralPath $EnvExample -Destination $EnvFile
    Write-Ok "criado $EnvFile"
    Write-Host ''
    Write-Info "Para hospedar neste PC é preciso ativar o bloco A do arquivo (tirar o '#' das linhas)"
    Write-Info 'e preencher LIVEKIT_API_SECRET (segredo aleatório) e LIVEKIT_URL (seu IP público ou DuckDNS).'
    Write-Host ''
    if (Confirm-Choice 'Quer que eu faça isso agora (ativar o bloco A, gerar o segredo e preencher o IP público)?') {
        $publicIp = Get-PublicIp
        $secret = New-Secret
        $lines = [IO.File]::ReadAllLines($EnvFile)
        $inBlock = $false
        for ($i = 0; $i -lt $lines.Length; $i++) {
            $line = $lines[$i]
            if ($line -match '^# ---- BLOCO A') { $inBlock = $true; continue }
            if ($line -match '^# ---- fim do bloco A') { $inBlock = $false; continue }
            if (-not $inBlock) { continue }
            if ($line -match '^#([A-Z_][A-Z0-9_]*=.*)$') {
                $line = $Matches[1]
                if ($line -match '^LIVEKIT_API_SECRET=') { $line = "LIVEKIT_API_SECRET=$secret" }
                if ($publicIp) { $line = $line.Replace('SEU-IP-PUBLICO-OU-DDNS', $publicIp) }
                $lines[$i] = $line
            }
        }
        [IO.File]::WriteAllLines($EnvFile, $lines, (New-Object Text.UTF8Encoding($false)))
        Write-Ok 'bloco A ativado e LIVEKIT_API_SECRET gerado'
        if ($publicIp) {
            Write-Ok "LIVEKIT_URL=ws://${publicIp}:$LiveKitPort (seu IP público agora)"
        } else {
            Write-Warn "não consegui descobrir seu IP público; edite LIVEKIT_URL em $EnvFile"
        }
        Write-Host ''
        Write-Info 'Revise o arquivo: se você tem DuckDNS, use o nome dele em LIVEKIT_URL; ajuste ROOMS se quiser.'
    } else {
        Write-Info "Ok. Edite $EnvFile por conta própria (as instruções estão dentro do arquivo)."
    }
    Write-Host ''
    Write-Info 'Depois crie os usuários (um por amigo) e rode este script de novo:'
    Write-Info '  pnpm --filter @telao/api user:add <id> <nome>     (na raiz do repositório)'
    Write-Info "  $ScriptCommand"
    exit 1
}

function Import-EnvFile {
    $vars = Read-EnvFile $EnvFile
    foreach ($name in @($vars.Keys)) {
        [Environment]::SetEnvironmentVariable($name, [string]$vars[$name], 'Process')
    }
    return $vars
}

function Test-EnvConfig($Vars) {
    $missing = @()
    foreach ($name in @('LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET')) {
        if ((Get-EnvValue $Vars $name) -eq '') { $missing += $name }
    }
    if ($missing.Count -gt 0) {
        Write-Fail "faltam variáveis em ${EnvFile}: $($missing -join ', ')"
        Write-Info 'Abra o arquivo e ative o bloco A (hospedagem local), ou apague o .env e rode o script de novo para recriá-lo.'
        exit 1
    }
    $secret = Get-EnvValue $Vars 'LIVEKIT_API_SECRET'
    if ($secret.Length -lt 32) {
        Write-Fail "LIVEKIT_API_SECRET precisa ter pelo menos 32 caracteres (tem $($secret.Length)). Gere um novo com:"
        Write-Info '  node -e "console.log(require(''crypto'').randomBytes(32).toString(''hex''))"'
        exit 1
    }
    $apiKey = Get-EnvValue $Vars 'LIVEKIT_API_KEY'
    $yamlKey = $null
    foreach ($line in [IO.File]::ReadAllLines($LiveKitConfig)) {
        if ($line -match '^\s*api_key:\s*(\S+)') { $yamlKey = $Matches[1] }
    }
    if ($yamlKey -and $yamlKey -ne $apiKey) {
        Write-Fail "LIVEKIT_API_KEY=$apiKey no .env, mas webhook.api_key: $yamlKey em infra\livekit.yaml. Precisam ser iguais (padrão: telao)."
        exit 1
    }
    if ((Get-EnvValue $Vars 'LIVEKIT_LOCAL_URL') -eq '') {
        Write-Warn "LIVEKIT_LOCAL_URL não definida; recomendado ws://127.0.0.1:$LiveKitPort para o seu próprio app não depender do roteador."
    }
    if (-not $LiveKitOnly) {
        $apiHost = Get-EnvValue $Vars 'HOST'
        if ($apiHost -eq '' -or $apiHost -eq '127.0.0.1' -or $apiHost -eq 'localhost') {
            Write-Warn "HOST='$apiHost' no .env: o api só aceita conexões deste PC. Para os amigos conectarem use HOST=0.0.0.0."
        }
    }
}

# ----------------------------------------------------------------------------
# Processos (PIDs em infra\local\.pids)
# ----------------------------------------------------------------------------
function Read-Pids {
    $entries = @()
    if (Test-Path -LiteralPath $PidsFile) {
        foreach ($line in [IO.File]::ReadAllLines($PidsFile)) {
            if ($line -match '^(\w+)=(\d+)$') {
                $entries += [pscustomobject]@{ Name = $Matches[1]; ProcessId = [int]$Matches[2] }
            }
        }
    }
    return $entries
}

function Test-ProcessAlive([int]$ProcessId) {
    return [bool](Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

function Stop-Telao {
    $entries = @(Read-Pids)
    if ($entries.Count -eq 0) {
        Write-Info 'Nada registrado em infra\local\.pids (nada iniciado por este script, ou já parado).'
    }
    foreach ($entry in $entries) {
        if (Test-ProcessAlive $entry.ProcessId) {
            Write-Step "Parando $($entry.Name) (PID $($entry.ProcessId) e processos filhos)"
            & taskkill.exe /PID $entry.ProcessId /T /F | Out-Null
        } else {
            Write-Info "$($entry.Name) (PID $($entry.ProcessId)) já não estava rodando."
        }
    }
    Remove-Item -LiteralPath $PidsFile -Force -ErrorAction SilentlyContinue
    # Segurança extra: livekit-server do nosso bin\ que tenha ficado órfão.
    Get-Process -Name 'livekit-server' -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -eq $LiveKitExe } |
        ForEach-Object {
            Write-Step "Parando livekit-server órfão (PID $($_.Id))"
            Stop-Process -Id $_.Id -Force
        }
    Write-Ok 'Telão parado.'
}

# Abre uma janela própria do PowerShell que roda o comando, espelha a saída em um log e
# fica aberta quando o processo termina (para dar tempo de ler o erro).
function Start-ConsoleWindow([string]$Title, [string]$CommandLine, [string]$WorkingDirectory, [string]$LogFile) {
    $template = @'
$Host.UI.RawUI.WindowTitle = '__TITLE__'
Set-Location -LiteralPath '__WORKDIR__'
Set-Content -LiteralPath '__LOG__' -Value ('# __TITLE__ ' + (Get-Date -Format s)) -Encoding UTF8
& { __CMD__ } 2>&1 | ForEach-Object { $line = [string]$_; Add-Content -LiteralPath '__LOG__' -Value $line -Encoding UTF8; $line }
Write-Host ''
Write-Host '[__TITLE__ terminou. O motivo está acima (e em __LOG__); esta janela pode ser fechada.]' -ForegroundColor Yellow
'@
    $script = $template.Replace('__TITLE__', $Title.Replace("'", "''")).
        Replace('__WORKDIR__', $WorkingDirectory.Replace("'", "''")).
        Replace('__LOG__', $LogFile.Replace("'", "''")).
        Replace('__CMD__', $CommandLine)
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
    $process = Start-Process -FilePath 'powershell.exe' -WorkingDirectory $WorkingDirectory -PassThru `
        -ArgumentList @('-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded)
    return $process.Id
}

function Wait-Http([string]$Url, [string]$ExpectedContent, [int]$TimeoutSeconds) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        try {
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
            if ($response.StatusCode -eq 200 -and $response.Content -like "*$ExpectedContent*") { return $true }
        } catch { }
        Start-Sleep -Milliseconds 800
    } while ((Get-Date) -lt $deadline)
    return $false
}

# ----------------------------------------------------------------------------
# Firewall do Windows
# ----------------------------------------------------------------------------
function Add-FirewallRules {
    if (-not (Test-IsElevated)) {
        Write-Warn 'Criar regras no Firewall do Windows exige PowerShell como Administrador.'
        Write-Info 'Menu Iniciar > digite "PowerShell" > botão direito > "Executar como administrador" e rode:'
        Write-Info "  $ScriptCommand -Firewall"
        if (Confirm-Choice 'Quer que eu abra essa janela de administrador agora (o Windows vai pedir confirmação)?' -DefaultNo) {
            Start-Process -FilePath 'powershell.exe' -Verb RunAs `
                -ArgumentList @('-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Firewall')
        }
        return
    }
    $rules = @(
        @{ Name = "Telao api (TCP $ApiPort)"; Protocol = 'TCP'; Port = @("$ApiPort") },
        @{ Name = "Telao LiveKit sinalizacao (TCP $LiveKitPort,$LiveKitTcpPort)"; Protocol = 'TCP'; Port = @("$LiveKitPort", "$LiveKitTcpPort") },
        @{ Name = "Telao LiveKit midia (UDP $UdpRangeStart-$UdpRangeEnd)"; Protocol = 'UDP'; Port = @("$UdpRangeStart-$UdpRangeEnd") }
    )
    Write-Step 'Criando regras de entrada no Firewall do Windows'
    foreach ($rule in $rules) {
        if (Get-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue) {
            Write-Ok "já existe: $($rule.Name)"
            continue
        }
        New-NetFirewallRule -DisplayName $rule.Name -Description 'Telao (compartilhamento de tela) - hospedagem local' `
            -Direction Inbound -Action Allow -Protocol $rule.Protocol -LocalPort $rule.Port -Profile Any | Out-Null
        Write-Ok "criada: $($rule.Name)"
    }
    Write-Info "Para remover depois: Get-NetFirewallRule -DisplayName 'Telao*' | Remove-NetFirewallRule"
}

# ----------------------------------------------------------------------------
# Resumo final
# ----------------------------------------------------------------------------
function Test-LiveKitUrl([string]$Url, [string]$PublicIp) {
    try {
        $uri = [Uri]$Url
    } catch {
        Write-Warn "LIVEKIT_URL inválida: $Url"
        return
    }
    $hostName = $uri.Host
    if ($hostName -in @('127.0.0.1', 'localhost', '0.0.0.0')) {
        Write-Warn "LIVEKIT_URL=$Url aponta para este PC; os amigos não vão conseguir conectar. Use ws://<IP público ou DuckDNS>:$LiveKitPort"
        return
    }
    if (-not $PublicIp) { return }
    $resolved = @()
    if ($hostName -match '^\d{1,3}(\.\d{1,3}){3}$') {
        $resolved = @($hostName)
    } else {
        try {
            $resolved = @([Net.Dns]::GetHostAddresses($hostName) | ForEach-Object { $_.IPAddressToString })
        } catch {
            Write-Warn "não consegui resolver '$hostName' (LIVEKIT_URL). O DuckDNS já foi criado?"
            return
        }
    }
    if ($resolved -contains $PublicIp) {
        Write-Ok "LIVEKIT_URL ($hostName) aponta para o seu IP público atual ($PublicIp)"
    } else {
        Write-Warn "LIVEKIT_URL ($hostName -> $($resolved -join ', ')) NÃO bate com o seu IP público atual ($PublicIp)."
        Write-Info 'Se usa DuckDNS, atualize-o (veja o README); se não, corrija LIVEKIT_URL no .env e rode -Stop e depois o script de novo.'
    }
}

function Show-Summary($Vars) {
    $publicIp = Get-PublicIp
    $lanIp = Get-LanIp
    $publicText = 'SEU-IP-PUBLICO'
    if ($publicIp) { $publicText = $publicIp }
    $lanText = '(não detectado; use ipconfig)'
    if ($lanIp) { $lanText = $lanIp }

    Write-Host ''
    Write-Host '==========================================================================' -ForegroundColor Green
    Write-Host '  Telão no ar!' -ForegroundColor Green
    Write-Host '=========================================================================='
    if ($LiveKitOnly) {
        Write-Host '  Só o LiveKit foi iniciado. Suba o api você mesmo:   pnpm dev:api'
    } else {
        Write-Host "  URL que os amigos digitam no app:   http://${publicText}:$ApiPort"
        Write-Host "  (com DuckDNS:                        http://<seu-nome>.duckdns.org:$ApiPort)"
        Write-Host "  Você, neste PC, usa:                 http://127.0.0.1:$ApiPort"
    }
    Write-Host '--------------------------------------------------------------------------'
    Write-Host "  Port forwarding no roteador  ->  IP deste PC na rede local: $lanText"
    Write-Host "    TCP $ApiPort              api (login, tokens, presença)"
    Write-Host "    TCP $LiveKitPort              LiveKit: sinalização (WebSocket)"
    Write-Host "    TCP $LiveKitTcpPort              LiveKit: ICE sobre TCP (fallback)"
    Write-Host "    UDP $UdpRangeStart-$UdpRangeEnd       LiveKit: mídia"
    Write-Host '--------------------------------------------------------------------------'
    Test-LiveKitUrl (Get-EnvValue $Vars 'LIVEKIT_URL') $publicIp
    $firewallRules = @(Get-NetFirewallRule -DisplayName 'Telao*' -ErrorAction SilentlyContinue)
    if ($firewallRules.Count -gt 0) {
        Write-Ok "Firewall do Windows: $($firewallRules.Count) regra(s) 'Telao*' encontrada(s)"
    } else {
        Write-Warn "Firewall do Windows: nenhuma regra 'Telao*'. Rode uma vez, como administrador:"
        Write-Info "  $ScriptCommand -Firewall"
    }
    Write-Host '--------------------------------------------------------------------------'
    Write-Host "  Logs: janelas 'Telao - LiveKit' / 'Telao - api' (cópia em infra\local\*.log)."
    Write-Host "  Para parar:  $ScriptCommand -Stop"
    Write-Host '=========================================================================='
}

# ----------------------------------------------------------------------------
# Fluxo principal
# ----------------------------------------------------------------------------
try {
    if ($Stop) { Stop-Telao; exit 0 }
    if ($Firewall) { Add-FirewallRules; exit 0 }

    Write-Host "Telão - hospedagem local  (repositório: $RepoRoot)"

    if (-not (Test-Path -LiteralPath $EnvFile)) { Initialize-EnvFile }   # termina o script

    Write-Step "Conferindo livekit-server $LiveKitVersion"
    Install-LiveKit

    Write-Step 'Lendo infra\.env'
    $vars = Import-EnvFile
    Test-EnvConfig $vars
    $env:LIVEKIT_KEYS = "$(Get-EnvValue $vars 'LIVEKIT_API_KEY'): $(Get-EnvValue $vars 'LIVEKIT_API_SECRET')"
    Write-Ok "LIVEKIT_URL=$(Get-EnvValue $vars 'LIVEKIT_URL')  ROOMS=$(Get-EnvValue $vars 'ROOMS')"

    if (-not $LiveKitOnly) {
        if (-not (Test-Path -LiteralPath $UsersFile)) {
            Write-Fail "não existe $UsersFile. Crie pelo menos um usuário (na raiz do repositório):"
            Write-Info '  pnpm --filter @telao/api user:add <id> <nome>'
            exit 1
        }
        if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
            Write-Fail 'pnpm não encontrado no PATH. Instale com: npm install -g pnpm   (ou corepack enable)'
            exit 1
        }
        if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot 'node_modules'))) {
            Write-Fail 'dependências não instaladas. Rode na raiz do repositório: pnpm install'
            exit 1
        }
    }

    $alive = @(Read-Pids | Where-Object { Test-ProcessAlive $_.ProcessId })
    if ($alive.Count -gt 0) {
        $list = ($alive | ForEach-Object { "$($_.Name)=$($_.ProcessId)" }) -join ', '
        Write-Fail "já existe um Telão iniciado por este script ($list). Pare antes com:  $ScriptCommand -Stop"
        exit 1
    }
    Remove-Item -LiteralPath $PidsFile -Force -ErrorAction SilentlyContinue

    $portsToCheck = @($LiveKitPort, $LiveKitTcpPort)
    if (-not $LiveKitOnly) { $portsToCheck += $ApiPort }
    foreach ($port in $portsToCheck) {
        $owner = Get-ListeningProcess $port
        if ($owner) {
            Write-Fail "a porta TCP $port já está em uso por $owner. Feche esse programa (ou rode -Stop) e tente de novo."
            exit 1
        }
    }

    Write-Step "Iniciando livekit-server (janela 'Telao - LiveKit')"
    $liveKitCommand = "& '$($LiveKitExe.Replace("'", "''"))' --config '$($LiveKitConfig.Replace("'", "''"))'"
    $liveKitPid = Start-ConsoleWindow -Title 'Telao - LiveKit' -CommandLine $liveKitCommand -WorkingDirectory $LocalDir -LogFile $LiveKitLog
    Set-Content -LiteralPath $PidsFile -Value "livekit=$liveKitPid" -Encoding ASCII
    Write-Ok "PID $liveKitPid"

    if (-not $LiveKitOnly) {
        Write-Step "Iniciando api (janela 'Telao - api')"
        $apiPid = Start-ConsoleWindow -Title 'Telao - api' -CommandLine 'pnpm --filter @telao/api start' -WorkingDirectory $RepoRoot -LogFile $ApiLog
        Add-Content -LiteralPath $PidsFile -Value "api=$apiPid" -Encoding ASCII
        Write-Ok "PID $apiPid"
    }

    Write-Step "Aguardando os serviços responderem (até $HealthTimeoutSeconds s)"
    $healthy = $true
    if (Wait-Http "http://127.0.0.1:$LiveKitPort/" 'OK' $HealthTimeoutSeconds) {
        Write-Ok "LiveKit respondeu em http://127.0.0.1:$LiveKitPort/"
    } else {
        Write-Fail "LiveKit não respondeu em http://127.0.0.1:$LiveKitPort/. Veja a janela 'Telao - LiveKit' ou $LiveKitLog"
        $healthy = $false
    }
    if (-not $LiveKitOnly) {
        if (Wait-Http "http://127.0.0.1:$ApiPort/api/health" '"ok":true' $HealthTimeoutSeconds) {
            Write-Ok "api respondeu em http://127.0.0.1:$ApiPort/api/health"
        } else {
            Write-Fail "api não respondeu em http://127.0.0.1:$ApiPort/api/health. Veja a janela 'Telao - api' ou $ApiLog"
            $healthy = $false
        }
    }
    if (-not $healthy) {
        Write-Info "Os processos continuam abertos para você ler o erro. Para encerrar:  $ScriptCommand -Stop"
        exit 1
    }

    Show-Summary $vars
    exit 0
} catch {
    Write-Fail $_.Exception.Message
    exit 1
}

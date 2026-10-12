<#
.SYNOPSIS
    Mantém o seu nome no DuckDNS apontando para o IP público deste PC (hospedagem local do Concord).

.DESCRIPTION
    Uso (no PowerShell, de qualquer pasta):

        powershell -ExecutionPolicy Bypass -File infra\local\duckdns.ps1 -Install

    Switches (sem nenhum = -Update):
        -Update   avisa o DuckDNS do IP público atual e grava uma linha em infra\local\duckdns.log.
                  É o que a tarefa agendada roda; o start.ps1 também chama isto ao subir o servidor.
        -Install  faz um -Update (e para se o DuckDNS responder KO) e registra a tarefa agendada
                  "Concord DuckDNS": roda a cada 5 minutos e ao fazer login no Windows, em segundo
                  plano, como o seu usuário (não precisa de administrador).
        -Remove   apaga a tarefa agendada.
        -Status   mostra a tarefa (última/próxima execução), o seu IP público, o IP para o qual o
                  nome aponta e se os dois batem.

    Lê DUCKDNS_DOMAIN (só o nome, ex.: concord-bryan) e DUCKDNS_TOKEN de infra\.env.
    Passo a passo: infra\local\README-local.md, seção "IP público dinâmico + DuckDNS".

    Códigos de saída: 0 = ok; 1 = DuckDNS respondeu KO, sem rede, .env incompleto ou (-Status)
    o nome não aponta para o IP atual.

    Compatível com Windows PowerShell 5.1 (o que vem no Windows 10/11) e PowerShell 7.
    Arquivo salvo em UTF-8 com BOM de propósito: sem o BOM o PowerShell 5.1 estraga os acentos.
#>
[CmdletBinding(DefaultParameterSetName = 'Update')]
param(
    [Parameter(ParameterSetName = 'Update')][switch]$Update,
    [Parameter(ParameterSetName = 'Install')][switch]$Install,
    [Parameter(ParameterSetName = 'Remove')][switch]$Remove,
    [Parameter(ParameterSetName = 'Status')][switch]$Status,
    # Os dois abaixo existem para testes; no uso normal ficam no padrão.
    [string]$TaskName = 'Concord DuckDNS',
    [string]$EnvFile = ''
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

# ----------------------------------------------------------------------------
# Constantes
# ----------------------------------------------------------------------------
$DuckDnsUpdateUrl = 'https://www.duckdns.org/update'
$DuckDnsSuffix = '.duckdns.org'
$RepetitionMinutes = 5
$HttpTimeoutSeconds = 10
$LogMaxBytes = 200KB
$LogKeepLines = 1000

$LocalDir = $PSScriptRoot
$InfraDir = Split-Path -Parent $LocalDir
$DefaultEnvFile = Join-Path $InfraDir '.env'
if ($EnvFile -eq '') { $EnvFile = $DefaultEnvFile }
$LogFile = Join-Path $LocalDir 'duckdns.log'
$ScriptCommand = "powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`""
$CurrentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$CurrentToken = ''   # preenchido ao ler o .env; serve só para mascarar o token em mensagens de erro

# ----------------------------------------------------------------------------
# Saída (mesmo estilo do start.ps1)
# ----------------------------------------------------------------------------
function Write-Step([string]$Message) { Write-Host ''; Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok([string]$Message) { Write-Host "    OK    $Message" -ForegroundColor Green }
function Write-Warn([string]$Message) { Write-Host "    AVISO $Message" -ForegroundColor Yellow }
function Write-Fail([string]$Message) { Write-Host "    ERRO  $Message" -ForegroundColor Red }
function Write-Info([string]$Message) { Write-Host "    $Message" }

# ----------------------------------------------------------------------------
# Utilitários (Read-EnvFile e Get-PublicIp são cópias do start.ps1: este script
# precisa rodar sozinho, pela tarefa agendada)
# ----------------------------------------------------------------------------
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

# Mostra só o começo do token (o resto vira asteriscos).
function Get-MaskedToken([string]$Token) {
    if ($Token.Length -le 8) { return '********' }
    return $Token.Substring(0, 4) + ('*' * ($Token.Length - 4))
}

# Nunca deixa o token aparecer na tela (nem dentro de uma URL numa mensagem de erro).
function Hide-Token([string]$Text) {
    if ($CurrentToken -ne '' -and $null -ne $Text) { return $Text.Replace($CurrentToken, (Get-MaskedToken $CurrentToken)) }
    return $Text
}

# Vazio ou um valor de exemplo que ninguém trocou (<...>, SEU-NOME, your-token...).
function Test-Placeholder([string]$Value) {
    if ($Value -eq '') { return $true }
    if ($Value -match '[<>]') { return $true }
    if ($Value -match '^(seu|sua|your)[-_ ]?(nome|name|token|dominio|domain)') { return $true }
    return $false
}

# "concord", "Concord.duckdns.org", "http://concord.duckdns.org/" -> "concord"
function ConvertTo-DuckDnsSubdomain([string]$Value) {
    $name = $Value.Trim().ToLowerInvariant()
    $name = $name -replace '^[a-z]+://', ''
    $name = $name.TrimEnd('/')
    if ($name.EndsWith($DuckDnsSuffix)) { $name = $name.Substring(0, $name.Length - $DuckDnsSuffix.Length) }
    return $name
}

function Show-SetupHelp {
    Write-Host ''
    Write-Info 'Como configurar o DuckDNS (grátis, uns 2 minutos):'
    Write-Info '  1. Entre em https://www.duckdns.org (login com GitHub ou Google).'
    Write-Info '  2. Em "sub domain" digite um nome (ex.: concord-bryan) e clique em "add domain".'
    Write-Info '  3. Copie o "token" que aparece no topo da página (é a senha da sua conta; não compartilhe).'
    Write-Info "  4. Em $EnvFile, no bloco A, preencha (sem o '#' na frente):"
    Write-Info '       DUCKDNS_DOMAIN=concord-bryan        (só o nome, sem .duckdns.org)'
    Write-Info '       DUCKDNS_TOKEN=cole-o-token-aqui'
    Write-Info "  5. Rode:  $ScriptCommand -Install"
    Write-Info '  Guia completo: infra\local\README-local.md, seção "IP público dinâmico + DuckDNS".'
}

# Devolve @{ Domain; Token; HostName } ou termina o script (exit 1) com instruções.
function Get-DuckDnsConfig {
    if (-not (Test-Path -LiteralPath $EnvFile)) {
        Write-Fail "não existe $EnvFile. Rode primeiro o start.ps1 (ele cria o arquivo) e preencha o DuckDNS nele."
        Show-SetupHelp
        exit 1
    }
    $vars = Read-EnvFile $EnvFile
    $domain = (Get-EnvValue $vars 'DUCKDNS_DOMAIN').Trim()
    $token = (Get-EnvValue $vars 'DUCKDNS_TOKEN').Trim()
    $missing = @()
    if (Test-Placeholder $domain) { $missing += 'DUCKDNS_DOMAIN' }
    if (Test-Placeholder $token) { $missing += 'DUCKDNS_TOKEN' }
    if ($missing.Count -gt 0) {
        Write-Fail "DuckDNS não configurado em ${EnvFile}: falta $($missing -join ' e ')."
        Show-SetupHelp
        exit 1
    }
    $script:CurrentToken = $token
    $domain = ConvertTo-DuckDnsSubdomain $domain
    if ($domain -notmatch '^[a-z0-9-]+$') {
        Write-Fail "DUCKDNS_DOMAIN='$domain' não parece um nome do DuckDNS: só letras, números e '-' (sem .duckdns.org)."
        exit 1
    }
    return @{ Domain = $domain; Token = $token; HostName = "$domain$DuckDnsSuffix" }
}

# ----------------------------------------------------------------------------
# Atualização (API do DuckDNS: GET /update?domains=...&token=...&ip=&verbose=true;
# ip vazio = o IPv4 de quem chamou; o corpo é "OK"/"KO" e, com verbose, o IP gravado)
# ----------------------------------------------------------------------------
function Invoke-DuckDnsUpdate($Config) {
    $query = "domains=$([Uri]::EscapeDataString($Config.Domain))&token=$([Uri]::EscapeDataString($Config.Token))&ip=&verbose=true"
    try {
        $response = Invoke-WebRequest -Uri "${DuckDnsUpdateUrl}?$query" -UseBasicParsing -TimeoutSec $HttpTimeoutSeconds
    } catch {
        $message = Hide-Token $_.Exception.Message
        return [pscustomobject]@{ Ok = $false; Status = 'ERRO'; Ip = ''; Change = ''; Message = "não consegui falar com www.duckdns.org: $message" }
    }
    # Sem Content-Type na resposta o PowerShell entrega bytes em vez de texto.
    $content = $response.Content
    if ($content -is [byte[]]) { $content = [Text.Encoding]::UTF8.GetString($content) }
    $body = ([string]$content).Trim()
    $lines = @($body -split "`r?`n" | ForEach-Object { $_.Trim() })
    $status = ''
    if ($lines.Count -gt 0) { $status = $lines[0].ToUpperInvariant() }
    $ip = ''
    $change = ''
    foreach ($line in $lines) {
        if ($ip -eq '' -and $line -match '^\d{1,3}(\.\d{1,3}){3}$') { $ip = $line }
        if ($line -match '^(UPDATED|NOCHANGE)$') { $change = $line.ToUpperInvariant() }
    }
    if ($status -eq 'OK') {
        return [pscustomobject]@{ Ok = $true; Status = 'OK'; Ip = $ip; Change = $change; Message = '' }
    }
    if ($status -eq 'KO') {
        return [pscustomobject]@{ Ok = $false; Status = 'KO'; Ip = ''; Change = ''; Message = 'o DuckDNS respondeu KO: DUCKDNS_TOKEN ou DUCKDNS_DOMAIN errados (confira os dois em https://www.duckdns.org)' }
    }
    $sample = $body
    if ($sample.Length -gt 60) { $sample = $sample.Substring(0, 60) + '...' }
    return [pscustomobject]@{ Ok = $false; Status = 'ERRO'; Ip = ''; Change = ''; Message = "resposta inesperada do DuckDNS: '$(Hide-Token $sample)'" }
}

# Uma linha por execução; quando passa de ~200 KB, mantém só as últimas $LogKeepLines linhas.
function Write-DuckDnsLog([string]$Line) {
    try {
        $utf8 = New-Object Text.UTF8Encoding($false)
        if ((Test-Path -LiteralPath $LogFile) -and (Get-Item -LiteralPath $LogFile).Length -gt $LogMaxBytes) {
            $lines = [string[]][IO.File]::ReadAllLines($LogFile)
            if ($lines.Length -gt $LogKeepLines) {
                $lines = [string[]]$lines[($lines.Length - $LogKeepLines)..($lines.Length - 1)]
            }
            [IO.File]::WriteAllLines($LogFile, $lines, $utf8)
        }
        [IO.File]::AppendAllText($LogFile, $Line + [Environment]::NewLine, $utf8)
    } catch {
        Write-Warn "não consegui escrever em ${LogFile}: $($_.Exception.Message)"
    }
}

# Faz a atualização, imprime o resultado e registra no log. Devolve $true se o DuckDNS respondeu OK.
function Update-DuckDns($Config) {
    $result = Invoke-DuckDnsUpdate $Config
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    if ($result.Ok) {
        $detail = $result.Ip
        if ($detail -eq '') { $detail = '(IP não informado)' }
        if ($result.Change -ne '') { $detail = "$detail  $($result.Change)" }
        Write-DuckDnsLog "$stamp  OK    $detail"
        $changeText = ''
        if ($result.Change -eq 'UPDATED') { $changeText = ' (IP atualizado)' }
        if ($result.Change -eq 'NOCHANGE') { $changeText = ' (sem mudança)' }
        Write-Ok "DuckDNS: $($Config.HostName) -> $($result.Ip)$changeText"
        return $true
    }
    Write-DuckDnsLog "$stamp  $($result.Status.PadRight(4))  $($result.Message)"
    Write-Fail "DuckDNS: $($result.Message)"
    if ($result.Status -eq 'KO') {
        Write-Info "Token em uso: $(Get-MaskedToken $Config.Token)   nome: $($Config.HostName)   arquivo: $EnvFile"
    }
    return $false
}

# ----------------------------------------------------------------------------
# Tarefa agendada (do usuário atual; não precisa de administrador)
# ----------------------------------------------------------------------------
function Get-DuckDnsTask {
    return (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)
}

function Register-DuckDnsTask($Config) {
    $arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Update"
    if ($EnvFile -ne $DefaultEnvFile) { $arguments += " -EnvFile `"$EnvFile`"" }
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments
    # Sem -RepetitionDuration a repetição é "indefinidamente" (Windows 10/11). Passar
    # [TimeSpan]::MaxValue dá "valor fora do intervalo" no Windows 11.
    $triggers = @(
        (New-ScheduledTaskTrigger -AtLogOn -User $CurrentUser),
        (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes $RepetitionMinutes))
    )
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
        -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -MultipleInstances IgnoreNew
    $principal = New-ScheduledTaskPrincipal -UserId $CurrentUser -LogonType Interactive -RunLevel Limited
    $description = "Concord: mantém $($Config.HostName) no DuckDNS apontando para o IP público deste PC (infra\local\duckdns.ps1 -Update, a cada $RepetitionMinutes min)."
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Settings $settings `
        -Principal $principal -Description $description -Force | Out-Null
}

function Format-TaskTime($Time) {
    if ($null -eq $Time) { return '-' }
    if ($Time -lt [datetime]'2000-01-01') { return 'nunca' }
    return $Time.ToString('dd/MM/yyyy HH:mm:ss')
}

function Format-TaskResult([uint32]$Code) {
    switch ($Code) {
        0 { return 'OK (0)' }
        1 { return 'falhou (1): DuckDNS respondeu KO ou sem rede; veja infra\local\duckdns.log' }
        267009 { return 'rodando agora (0x41301)' }
        267011 { return 'ainda não rodou (0x41303)' }
        267014 { return 'encerrada à força (0x41306)' }
        2147942402 { return 'arquivo não encontrado (0x80070002): o duckdns.ps1 mudou de lugar? Rode -Install de novo' }
        default { return ('código {0} (0x{0:X})' -f $Code) }
    }
}

# Devolve $true quando tudo está em ordem (tarefa registrada e nome apontando para o IP atual).
function Show-Status($Config) {
    $allGood = $true

    Write-Step "Tarefa agendada '$TaskName'"
    $task = Get-DuckDnsTask
    if ($task) {
        $info = Get-ScheduledTaskInfo -TaskName $TaskName
        Write-Ok "registrada (estado: $($task.State); usuário: $($task.Principal.UserId))"
        Write-Info "última execução: $(Format-TaskTime $info.LastRunTime)  ->  $(Format-TaskResult $info.LastTaskResult)"
        Write-Info "próxima execução: $(Format-TaskTime $info.NextRunTime)"
        if ($info.LastTaskResult -notin @(0, 267009, 267011)) { $allGood = $false }
    } else {
        Write-Warn 'não está registrada: o IP só é atualizado quando o start.ps1 sobe o servidor. Para criar:'
        Write-Info "  $ScriptCommand -Install"
        $allGood = $false
    }

    Write-Step "Endereços de $($Config.HostName)"
    $publicIp = Get-PublicIp
    if ($publicIp) {
        Write-Info "IP público deste PC agora: $publicIp"
    } else {
        Write-Warn 'não consegui descobrir o IP público deste PC (sem internet?)'
        $allGood = $false
    }
    $resolved = @()
    $resolves = $true
    try {
        $resolved = @([Net.Dns]::GetHostAddresses($Config.HostName) |
            Where-Object { $_.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetwork } |
            ForEach-Object { $_.IPAddressToString })
    } catch {
        $resolves = $false
    }
    if (-not $resolves) {
        Write-Warn "$($Config.HostName) não resolve no DNS. O nome existe na sua conta do DuckDNS? Já rodou -Update pelo menos uma vez?"
        $allGood = $false
    } elseif ($resolved.Count -eq 0) {
        Write-Warn "$($Config.HostName) não tem endereço IPv4 no DNS. Rode -Update."
        $allGood = $false
    } else {
        Write-Info "$($Config.HostName) aponta para: $($resolved -join ', ')"
        if ($publicIp) {
            if ($resolved -contains $publicIp) {
                Write-Ok 'o nome aponta para o seu IP público atual'
            } else {
                Write-Warn 'o nome NÃO aponta para o seu IP público atual. Rode -Update; o DNS leva até ~1 min para propagar (cache local: ipconfig /flushdns).'
                $allGood = $false
            }
        }
    }

    if (Test-Path -LiteralPath $LogFile) {
        Write-Step "Últimas linhas de $LogFile"
        foreach ($line in @([IO.File]::ReadAllLines($LogFile) | Select-Object -Last 3)) { Write-Info $line }
    }
    return $allGood
}

# ----------------------------------------------------------------------------
# Fluxo principal
# ----------------------------------------------------------------------------
# Carregado com ". .\duckdns.ps1" (dot-source, para testes) só define as funções acima.
if ($MyInvocation.InvocationName -eq '.') { return }

try {
    switch ($PSCmdlet.ParameterSetName) {
        'Update' {
            $config = Get-DuckDnsConfig
            if (Update-DuckDns $config) { exit 0 }
            exit 1
        }
        'Install' {
            $config = Get-DuckDnsConfig
            Write-Step "Atualizando $($config.HostName) no DuckDNS"
            if (-not (Update-DuckDns $config)) {
                Write-Info 'A tarefa agendada NÃO foi criada. Corrija o .env e rode -Install de novo.'
                exit 1
            }
            Write-Step "Registrando a tarefa agendada '$TaskName' (a cada $RepetitionMinutes min e ao fazer login, como $CurrentUser)"
            Register-DuckDnsTask $config
            $info = Get-ScheduledTaskInfo -TaskName $TaskName
            Write-Ok "tarefa '$TaskName' registrada; próxima execução: $(Format-TaskTime $info.NextRunTime)"
            Write-Info 'Ela roda em segundo plano enquanto você estiver logado no Windows (Agendador de Tarefas > Biblioteca).'
            Write-Info "Conferir:  $ScriptCommand -Status"
            Write-Info "Remover:   $ScriptCommand -Remove"
            exit 0
        }
        'Remove' {
            Write-Step "Removendo a tarefa agendada '$TaskName'"
            if (-not (Get-DuckDnsTask)) {
                Write-Ok "a tarefa '$TaskName' não existe; nada a remover."
                exit 0
            }
            Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
            if (Get-DuckDnsTask) {
                Write-Fail "a tarefa '$TaskName' continua registrada (sem permissão? ela foi criada por outro usuário?)"
                exit 1
            }
            Write-Ok "tarefa '$TaskName' removida. O DuckDNS deixa de ser atualizado sozinho (o start.ps1 ainda atualiza ao subir o servidor)."
            exit 0
        }
        'Status' {
            $config = Get-DuckDnsConfig
            if (Show-Status $config) { exit 0 }
            exit 1
        }
    }
} catch {
    Write-Fail (Hide-Token $_.Exception.Message)
    exit 1
}

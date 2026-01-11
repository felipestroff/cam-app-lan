param(
  [ValidateSet("start", "stop", "restart", "status")]
  [string]$Action = "start",
  [switch]$NoBuild
)

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$exePath = Join-Path $root "mediamtx\\mediamtx.exe"
$configPath = Join-Path $root "mediamtx\\mediamtx.yml"
$logDir = Join-Path $root "logs"
$pidFile = Join-Path $logDir "mediamtx.pid"
$stdoutLog = Join-Path $logDir "mediamtx.log"
$stderrLog = Join-Path $logDir "mediamtx.err.log"

function Get-MediaMtxProcess {
  if (Test-Path $pidFile) {
    $raw = Get-Content -Path $pidFile -Raw
    if ($raw -match "\d+") {
      $processId = [int]$Matches[0]
      try {
        return Get-Process -Id $processId -ErrorAction Stop
      } catch {
        return $null
      }
    }
  }
  return Get-Process -Name "mediamtx" -ErrorAction SilentlyContinue | Select-Object -First 1
}

function Stop-MediaMtx {
  $proc = Get-MediaMtxProcess
  if (-not $proc) {
    Write-Host "MediaMTX nao esta rodando."
    return
  }
  Stop-Process -Id $proc.Id -Force
  if (Test-Path $pidFile) {
    Remove-Item -Path $pidFile -Force -ErrorAction SilentlyContinue
  }
  Write-Host "MediaMTX parado (PID $($proc.Id))."
}

function Start-MediaMtx {
  if (-not (Test-Path $exePath)) {
    Write-Error "mediamtx.exe nao encontrado em $exePath"
    exit 1
  }
  if (-not (Test-Path $configPath)) {
    Write-Error "mediamtx.yml nao encontrado em $configPath"
    exit 1
  }
  if (-not $NoBuild) {
    Write-Host "Gerando configuracao do MediaMTX..."
    & node (Join-Path $root "scripts\\build-mediamtx-config.js")
    if ($LASTEXITCODE -ne 0) {
      Write-Error "Falha ao gerar mediamtx.yml"
      exit 1
    }
  }

  $proc = Get-MediaMtxProcess
  if ($proc) {
    Write-Host "MediaMTX ja esta rodando (PID $($proc.Id))."
    return
  }

  if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir | Out-Null
  }

  $proc = Start-Process -FilePath $exePath -ArgumentList $configPath -PassThru `
    -NoNewWindow -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog

  $proc.Id | Set-Content -Path $pidFile -Encoding ascii
  Write-Host "MediaMTX iniciado (PID $($proc.Id))."
  Write-Host "Logs: $stdoutLog"
}

switch ($Action) {
  "start" { Start-MediaMtx }
  "stop" { Stop-MediaMtx }
  "restart" {
    Stop-MediaMtx
    Start-MediaMtx
  }
  "status" {
    $proc = Get-MediaMtxProcess
    if ($proc) {
      Write-Host "MediaMTX rodando (PID $($proc.Id))."
    } else {
      Write-Host "MediaMTX parado."
    }
  }
}

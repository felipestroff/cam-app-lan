param(
  [string]$Root = (Join-Path $PSScriptRoot "..\\web"),
  [int]$Port = 5173,
  [string]$HostName = "localhost",
  [ValidateSet("http", "https")]
  [string]$Scheme = "http",
  [string]$RecordingsDir = (Join-Path $PSScriptRoot "..\\recordings")
)

$resolvedRoot = Resolve-Path $Root
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$serverConfigFile = Join-Path $repoRoot "server-config.json"
$defaultRecordingsDir = $RecordingsDir
$defaultRecordingFormat = "mp4"
$defaultRecordingNamePattern = "{camera}-{data}-{hora}"
$defaultMotionDefaults = @{
  enabled = $false
  sensitivity = 60
  stopAfter = 6
}
$defaultForceHttps = $false
$defaultLogsVerbose = $true
$listener = [System.Net.HttpListener]::new()
$prefix = "${Scheme}://${HostName}:$Port/"
$listener.Prefixes.Add($prefix)

try {
  $listener.Start()
} catch {
  Write-Error "Nao foi possivel iniciar o servidor em $prefix. Verifique permissoes ou altere a porta."
  exit 1
}

$mimeTypes = @{
  ".html" = "text/html"
  ".js" = "application/javascript"
  ".css" = "text/css"
  ".json" = "application/json"
  ".svg" = "image/svg+xml"
  ".png" = "image/png"
  ".jpg" = "image/jpeg"
  ".jpeg" = "image/jpeg"
}

$rooms = @{}
$webrtcTimeoutSeconds = 30
$ipCameraTimeoutSeconds = 0
$discoveredFile = Join-Path $resolvedRoot "ip-cameras.json"
$fallbackDiscoveredFile = Join-Path $repoRoot "web\\ip-cameras.json"
$rtspOverridesFile = Join-Path $PSScriptRoot "ip-cameras-rtsp.json"
$mediamtxLogFile = Join-Path $repoRoot "logs\\mediamtx.log"
$mediamtxErrLogFile = Join-Path $repoRoot "logs\\mediamtx.err.log"
$cachedIpCameras = @()

function Add-CorsHeaders {
  param([System.Net.HttpListenerResponse]$Response)
  $Response.Headers["Access-Control-Allow-Origin"] = "*"
  $Response.Headers["Access-Control-Allow-Headers"] = "Content-Type, X-Filename"
  $Response.Headers["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS"
  $Response.Headers["Cache-Control"] = "no-store"
}

function Send-EmptyResponse {
  param(
    [System.Net.HttpListenerResponse]$Response,
    [int]$StatusCode
  )
  Add-CorsHeaders $Response
  $Response.StatusCode = $StatusCode
  $Response.OutputStream.Close()
}

function Send-JsonResponse {
  param(
    [System.Net.HttpListenerResponse]$Response,
    [int]$StatusCode,
    $Payload
  )
  Add-CorsHeaders $Response
  if ($null -eq $Payload) {
    $json = "null"
  } elseif ($Payload -is [System.Array]) {
    if ($Payload.Length -eq 0) {
      $json = "[]"
    } else {
      $json = ConvertTo-Json -Depth 6 -InputObject $Payload
      if ($Payload.Length -eq 1 -and $json -notmatch '^\s*\[') {
        $json = "[$json]"
      }
    }
  } else {
    $json = ConvertTo-Json -Depth 6 -InputObject $Payload
    if ([string]::IsNullOrWhiteSpace($json)) {
      $json = "{}"
    }
  }
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  $Response.StatusCode = $StatusCode
  $Response.ContentType = "application/json"
  $Response.ContentLength64 = $bytes.Length
  $Response.OutputStream.Write($bytes, 0, $bytes.Length)
  $Response.OutputStream.Close()
}

function Send-TextResponse {
  param(
    [System.Net.HttpListenerResponse]$Response,
    [int]$StatusCode,
    [string]$Text
  )
  Add-CorsHeaders $Response
  if ($null -eq $Text) {
    $Text = ""
  }
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
  $Response.StatusCode = $StatusCode
  $Response.ContentType = "text/plain; charset=utf-8"
  $Response.ContentLength64 = $bytes.Length
  $Response.OutputStream.Write($bytes, 0, $bytes.Length)
  $Response.OutputStream.Close()
}

function Read-JsonBody {
  param([System.Net.HttpListenerRequest]$Request)
  $reader = New-Object System.IO.StreamReader($Request.InputStream, $Request.ContentEncoding)
  $body = $reader.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($body)) {
    return $null
  }
  return $body | ConvertFrom-Json
}

function Read-JsonFile {
  param([string]$FilePath)
  if (-not (Test-Path $FilePath)) {
    return @()
  }
  try {
    $raw = Get-Content -Path $FilePath -Raw -Encoding UTF8
    if ([string]::IsNullOrWhiteSpace($raw)) {
      return @()
    }
    $data = $raw | ConvertFrom-Json
    if ($data -isnot [System.Array]) {
      return @($data)
    }
    return $data
  } catch {
    return $null
  }
}

function Read-ServerConfig {
  param([string]$FilePath)
  if (-not (Test-Path $FilePath)) {
    return @{}
  }
  try {
    $raw = Get-Content -Path $FilePath -Raw -Encoding UTF8
    if ([string]::IsNullOrWhiteSpace($raw)) {
      return @{}
    }
    $parsed = $raw | ConvertFrom-Json
    if ($null -eq $parsed) {
      return @{}
    }
    $result = @{}
    if ($parsed.PSObject.Properties.Name -contains "recordingsDir") {
      if ($null -ne $parsed.recordingsDir) {
        $result.recordingsDir = $parsed.recordingsDir.ToString()
      }
    }
    if ($parsed.PSObject.Properties.Name -contains "signalBase") {
      if ($null -ne $parsed.signalBase) {
        $result.signalBase = $parsed.signalBase.ToString()
      }
    }
    if ($parsed.PSObject.Properties.Name -contains "mediaBase") {
      if ($null -ne $parsed.mediaBase) {
        $result.mediaBase = $parsed.mediaBase.ToString()
      }
    }
    if ($parsed.PSObject.Properties.Name -contains "recordingFormat") {
      if ($null -ne $parsed.recordingFormat) {
        $result.recordingFormat = $parsed.recordingFormat.ToString()
      }
    }
    if ($parsed.PSObject.Properties.Name -contains "recordingNamePattern") {
      if ($null -ne $parsed.recordingNamePattern) {
        $result.recordingNamePattern = $parsed.recordingNamePattern.ToString()
      }
    }
    if ($parsed.PSObject.Properties.Name -contains "forceHttps") {
      $result.forceHttps = [bool]$parsed.forceHttps
    }
    if ($parsed.PSObject.Properties.Name -contains "logsVerbose") {
      $result.logsVerbose = [bool]$parsed.logsVerbose
    }
    if ($parsed.PSObject.Properties.Name -contains "motionDefaults") {
      if ($null -ne $parsed.motionDefaults) {
        $result.motionDefaults = $parsed.motionDefaults
      }
    }
    return $result
  } catch {
    return @{}
  }
}

function Write-ServerConfig {
  param(
    [string]$FilePath,
    $Config
  )
  $json = ConvertTo-Json -Depth 4 -InputObject $Config
  [System.IO.File]::WriteAllText($FilePath, $json, [System.Text.Encoding]::UTF8)
}

function Get-ServerConfig {
  param([string]$DefaultRecordingsDir)
  $config = Read-ServerConfig -FilePath $serverConfigFile
  $recordingsDir = $config.recordingsDir
  if ([string]::IsNullOrWhiteSpace($recordingsDir)) {
    $recordingsDir = $DefaultRecordingsDir
  }
  $resolved = $recordingsDir
  if (-not [System.IO.Path]::IsPathRooted($recordingsDir)) {
    $resolved = Join-Path $repoRoot $recordingsDir
  }
  $resolved = [System.IO.Path]::GetFullPath($resolved)
  $signalBase = ""
  if ($config.signalBase) {
    $signalBase = $config.signalBase
  }
  $mediaBase = ""
  if ($config.mediaBase) {
    $mediaBase = $config.mediaBase
  }
  $recordingFormat = $defaultRecordingFormat
  if ($config.recordingFormat) {
    $candidate = $config.recordingFormat.ToString().ToLower()
    if ($candidate -eq "mp4" -or $candidate -eq "webm") {
      $recordingFormat = $candidate
    }
  }
  $recordingNamePattern = $defaultRecordingNamePattern
  if ($config.recordingNamePattern) {
    $recordingNamePattern = $config.recordingNamePattern
  }
  $forceHttps = $defaultForceHttps
  if ($null -ne $config.forceHttps) {
    $forceHttps = [bool]$config.forceHttps
  }
  $logsVerbose = $defaultLogsVerbose
  if ($null -ne $config.logsVerbose) {
    $logsVerbose = [bool]$config.logsVerbose
  }
  $motionDefaults = @{
    enabled = $defaultMotionDefaults.enabled
    sensitivity = $defaultMotionDefaults.sensitivity
    stopAfter = $defaultMotionDefaults.stopAfter
  }
  if ($config.motionDefaults) {
    if ($null -ne $config.motionDefaults.enabled) {
      $motionDefaults.enabled = [bool]$config.motionDefaults.enabled
    }
    if ($config.motionDefaults.sensitivity) {
      $motionDefaults.sensitivity = [int]$config.motionDefaults.sensitivity
    }
    if ($config.motionDefaults.stopAfter) {
      $motionDefaults.stopAfter = [int]$config.motionDefaults.stopAfter
    }
  }
  return @{
    recordingsDir = $recordingsDir
    recordingsDirResolved = $resolved
    signalBase = $signalBase
    mediaBase = $mediaBase
    recordingFormat = $recordingFormat
    recordingNamePattern = $recordingNamePattern
    forceHttps = $forceHttps
    logsVerbose = $logsVerbose
    motionDefaults = $motionDefaults
  }
}

function Get-ExtensionFromContentType {
  param([string]$ContentType)
  if ([string]::IsNullOrWhiteSpace($ContentType)) {
    return ".bin"
  }
  $value = $ContentType.Split(";")[0].Trim().ToLower()
  switch ($value) {
    "video/mp4" { return ".mp4" }
    "video/webm" { return ".webm" }
    default { return ".bin" }
  }
}

function Get-SafeFilename {
  param(
    [string]$Name,
    [string]$ContentType
  )
  $fallbackBase = "recording-" + (Get-Date -Format "yyyyMMdd-HHmmss")
  if ([string]::IsNullOrWhiteSpace($Name)) {
    $Name = $fallbackBase
  }
  $safe = [System.IO.Path]::GetFileName($Name)
  $safe = $safe -replace "[^a-zA-Z0-9._-]", "-"
  $safe = $safe -replace "-{2,}", "-"
  $safe = $safe.Trim([char[]]"-. _")
  if ([string]::IsNullOrWhiteSpace($safe)) {
    $safe = $fallbackBase
  }
  $ext = [System.IO.Path]::GetExtension($safe)
  if ([string]::IsNullOrWhiteSpace($ext)) {
    $ext = Get-ExtensionFromContentType -ContentType $ContentType
    $safe = "$safe$ext"
  }
  return $safe
}

function Get-UniquePath {
  param([string]$Path)
  if (-not (Test-Path $Path)) {
    return $Path
  }
  $dir = [System.IO.Path]::GetDirectoryName($Path)
  $name = [System.IO.Path]::GetFileNameWithoutExtension($Path)
  $ext = [System.IO.Path]::GetExtension($Path)
  $counter = 1
  do {
    $candidate = Join-Path $dir "$name-$counter$ext"
    $counter += 1
  } while (Test-Path $candidate)
  return $candidate
}

function Get-DefaultMediaBase {
  param([System.Net.HttpListenerRequest]$Request)
  $scheme = $Request.Url.Scheme
  $host = $Request.Url.Host
  return "${scheme}://${host}:8889"
}

function Test-MediaBaseStatus {
  param([string]$BaseUrl)
  $result = @{
    ok = $false
    status = $null
  }
  try {
    $request = [System.Net.HttpWebRequest]::Create($BaseUrl)
    $request.Method = "GET"
    $request.Timeout = 2000
    $request.AllowAutoRedirect = $true
    $response = $request.GetResponse()
    $statusCode = [int]$response.StatusCode
    $response.Close()
    $result.ok = $true
    $result.status = $statusCode
    return $result
  } catch [System.Net.WebException] {
    if ($_.Exception.Response) {
      try {
        $statusCode = [int]$_.Exception.Response.StatusCode
        $result.ok = $true
        $result.status = $statusCode
      } catch {
        $result.ok = $false
      }
    }
    return $result
  } catch {
    return $result
  }
}

function Get-QueryValue {
  param(
    [System.Net.HttpListenerRequest]$Request,
    [string]$Name
  )
  $query = $Request.Url.Query
  if (-not $query) {
    return $null
  }
  $trimmed = $query.TrimStart("?")
  foreach ($pair in $trimmed -split "&") {
    if ([string]::IsNullOrWhiteSpace($pair)) {
      continue
    }
    $parts = $pair -split "=", 2
    $key = [System.Uri]::UnescapeDataString($parts[0])
    if ($key -eq $Name) {
      if ($parts.Length -gt 1) {
        return [System.Uri]::UnescapeDataString($parts[1])
      }
      return ""
    }
  }
  return $null
}

function Get-Room {
  param([string]$Path)
  if (-not $rooms.ContainsKey($Path)) {
    $rooms[$Path] = @{
      Offer = $null
      Answer = $null
      Updated = [DateTime]::UtcNow
      Name = $null
      Id = $null
      LastSeen = $null
    }
  }
  return $rooms[$Path]
}

Write-Host "Servindo $resolvedRoot em $prefix (Ctrl+C para parar)"

while ($listener.IsListening) {
  $context = $listener.GetContext()
  $request = $context.Request
  $response = $context.Response

  $requestPath = $request.Url.AbsolutePath.ToLower()
  if ($requestPath.StartsWith("/signal/")) {
    if ($request.HttpMethod -eq "OPTIONS") {
      Send-EmptyResponse -Response $response -StatusCode 204
      continue
    }

    switch ($requestPath) {
      "/signal/offer" {
        if ($request.HttpMethod -eq "POST") {
          $data = Read-JsonBody -Request $request
          if (-not $data -or -not $data.path -or -not $data.sdp) {
            Send-JsonResponse -Response $response -StatusCode 400 -Payload @{ error = "invalid payload" }
            continue
          }
          $room = Get-Room -Path $data.path
          $room.Offer = @{
            type = $data.type
            sdp = $data.sdp
            ts = [DateTime]::UtcNow.ToString("o")
          }
          if ($data.name) {
            $room.Name = $data.name
          }
          if ($data.id) {
            $room.Id = $data.id
          }
          $room.Answer = $null
          $room.LastSeen = [DateTime]::UtcNow
          $room.Updated = [DateTime]::UtcNow
          Send-JsonResponse -Response $response -StatusCode 200 -Payload @{ ok = $true }
          continue
        }

        if ($request.HttpMethod -eq "GET") {
          $pathValue = Get-QueryValue -Request $request -Name "path"
          if (-not $pathValue) {
            Send-JsonResponse -Response $response -StatusCode 400 -Payload @{ error = "path required" }
            continue
          }
          if ($rooms.ContainsKey($pathValue) -and $rooms[$pathValue].Offer) {
            Send-JsonResponse -Response $response -StatusCode 200 -Payload $rooms[$pathValue].Offer
          } else {
            Send-EmptyResponse -Response $response -StatusCode 204
          }
          continue
        }

        Send-EmptyResponse -Response $response -StatusCode 405
        continue
      }
      "/signal/answer" {
        if ($request.HttpMethod -eq "POST") {
          $data = Read-JsonBody -Request $request
          if (-not $data -or -not $data.path -or -not $data.sdp) {
            Send-JsonResponse -Response $response -StatusCode 400 -Payload @{ error = "invalid payload" }
            continue
          }
          $room = Get-Room -Path $data.path
          $room.Answer = @{
            type = $data.type
            sdp = $data.sdp
            ts = [DateTime]::UtcNow.ToString("o")
          }
          $room.Updated = [DateTime]::UtcNow
          Send-JsonResponse -Response $response -StatusCode 200 -Payload @{ ok = $true }
          continue
        }

        if ($request.HttpMethod -eq "GET") {
          $pathValue = Get-QueryValue -Request $request -Name "path"
          if (-not $pathValue) {
            Send-JsonResponse -Response $response -StatusCode 400 -Payload @{ error = "path required" }
            continue
          }
          if ($rooms.ContainsKey($pathValue) -and $rooms[$pathValue].Answer) {
            Send-JsonResponse -Response $response -StatusCode 200 -Payload $rooms[$pathValue].Answer
          } else {
            Send-EmptyResponse -Response $response -StatusCode 204
          }
          continue
        }

        Send-EmptyResponse -Response $response -StatusCode 405
        continue
      }
      "/signal/reset" {
        if ($request.HttpMethod -eq "POST") {
          $data = Read-JsonBody -Request $request
          if (-not $data -or -not $data.path) {
            Send-JsonResponse -Response $response -StatusCode 400 -Payload @{ error = "path required" }
            continue
          }
          if ($rooms.ContainsKey($data.path)) {
            $rooms[$data.path].Offer = $null
            $rooms[$data.path].Answer = $null
            $rooms[$data.path].Updated = [DateTime]::UtcNow
          }
          Send-JsonResponse -Response $response -StatusCode 200 -Payload @{ ok = $true }
          continue
        }

        Send-EmptyResponse -Response $response -StatusCode 405
        continue
      }
      "/signal/ping" {
        if ($request.HttpMethod -eq "POST") {
          $data = Read-JsonBody -Request $request
          if (-not $data -or -not $data.path) {
            Send-JsonResponse -Response $response -StatusCode 400 -Payload @{ error = "path required" }
            continue
          }
          $room = Get-Room -Path $data.path
          if ($data.name) {
            $room.Name = $data.name
          }
          if ($data.id) {
            $room.Id = $data.id
          }
          $room.LastSeen = [DateTime]::UtcNow
          $room.Updated = [DateTime]::UtcNow
          Send-JsonResponse -Response $response -StatusCode 200 -Payload @{ ok = $true }
          continue
        }

        Send-EmptyResponse -Response $response -StatusCode 405
        continue
      }
      Default {
        Send-EmptyResponse -Response $response -StatusCode 404
        continue
      }
    }
  }

  if ($requestPath -eq "/cameras") {
    if ($request.HttpMethod -eq "GET") {
      $items = @()
      $stalePaths = @()
      $now = [DateTime]::UtcNow
      $rtspOverrides = @{}
      if (Test-Path $rtspOverridesFile) {
        try {
          $rawOverrides = Get-Content -Path $rtspOverridesFile -Raw
          if (-not [string]::IsNullOrWhiteSpace($rawOverrides)) {
            $parsedOverrides = $rawOverrides | ConvertFrom-Json
            if ($parsedOverrides -isnot [System.Array]) {
              $parsedOverrides = @($parsedOverrides)
            }
            foreach ($override in $parsedOverrides) {
              if ($override.id -and $override.rtspUrl) {
                $rtspOverrides[$override.id.ToString()] = $true
              }
            }
          }
        } catch {
          # ignore invalid overrides
        }
      }
      foreach ($path in $rooms.Keys) {
        $room = $rooms[$path]
        $lastSeen = $room.LastSeen
        $isStale = $true
        if ($lastSeen) {
          $age = ($now - $lastSeen).TotalSeconds
          $isStale = $age -gt $webrtcTimeoutSeconds
        }
        if ($isStale) {
          $stalePaths += $path
          continue
        }
        $items += @{
          id = $(if ($room.Id) { $room.Id } else { $path })
          name = $room.Name
          path = $path
          source = "webrtc"
          active = [bool]$room.Offer
          updated = $room.Updated.ToString("o")
          lastSeen = $(if ($room.LastSeen) { $room.LastSeen.ToString("o") } else { $null })
        }
      }
      $discovered = @()
      $pathsToCheck = @($discoveredFile, $fallbackDiscoveredFile) | Select-Object -Unique
      foreach ($filePath in $pathsToCheck) {
        $data = Read-JsonFile -FilePath $filePath
        if ($null -eq $data) {
          continue
        }
        if ($data.Count -gt 0) {
          $discovered = $data
          break
        }
      }
      if ($discovered.Count -eq 0 -and $cachedIpCameras.Count -gt 0) {
        $discovered = $cachedIpCameras
      }
      if ($discovered.Count -gt 0) {
        $cachedIpCameras = $discovered
      }
      foreach ($cam in $discovered) {
        $lastSeenValue = $null
        if ($cam.lastSeen) {
          [DateTime]::TryParse($cam.lastSeen.ToString(), [ref]$lastSeenValue) | Out-Null
        }
        if ($lastSeenValue -and $ipCameraTimeoutSeconds -gt 0) {
          $age = ($now - $lastSeenValue).TotalSeconds
          if ($age -gt $ipCameraTimeoutSeconds) {
            continue
          }
        }
        $items += @{
          id = $cam.id
          name = $cam.name
          path = $cam.path
          source = $(if ($cam.source) { $cam.source } else { "onvif" })
          host = $cam.host
          rtspReachable = $cam.rtspReachable
          rtspConfigured = $(if ($cam.id -and $rtspOverrides.ContainsKey($cam.id.ToString())) { $true } else { $false })
          active = $(if ($null -ne $cam.active) { [bool]$cam.active } else { $true })
          updated = $(if ($cam.updated) { $cam.updated.ToString() } else { $now.ToString("o") })
          lastSeen = $(if ($cam.lastSeen) { $cam.lastSeen.ToString() } else { $null })
        }
      }
      foreach ($path in $stalePaths) {
        $rooms.Remove($path) | Out-Null
      }
      Send-JsonResponse -Response $response -StatusCode 200 -Payload $items
      continue
    }

    Send-EmptyResponse -Response $response -StatusCode 405
    continue
  }

  if ($requestPath -eq "/config") {
    if ($request.HttpMethod -eq "OPTIONS") {
      Send-EmptyResponse -Response $response -StatusCode 204
      continue
    }

    if ($request.HttpMethod -eq "GET") {
      $config = Get-ServerConfig -DefaultRecordingsDir $defaultRecordingsDir
      Send-JsonResponse -Response $response -StatusCode 200 -Payload $config
      continue
    }

      if ($request.HttpMethod -eq "POST") {
        $data = Read-JsonBody -Request $request
        if ($null -eq $data) {
          Send-JsonResponse -Response $response -StatusCode 400 -Payload @{ error = "invalid payload" }
          continue
        }
        $payload = @{}
        if ($data.PSObject.Properties.Name -contains "recordingsDir") {
          $recordingsDir = $data.recordingsDir
          if ($recordingsDir) {
            $recordingsDir = $recordingsDir.ToString().Trim()
          }
          if (-not [string]::IsNullOrWhiteSpace($recordingsDir)) {
            $payload.recordingsDir = $recordingsDir
          }
        }
        if ($data.PSObject.Properties.Name -contains "recordingFormat") {
          $recordingFormat = $data.recordingFormat
          if ($recordingFormat) {
            $recordingFormat = $recordingFormat.ToString().Trim().ToLower()
          }
          if ($recordingFormat -eq "mp4" -or $recordingFormat -eq "webm") {
            $payload.recordingFormat = $recordingFormat
          }
        }
        if ($data.PSObject.Properties.Name -contains "recordingNamePattern") {
          $recordingNamePattern = $data.recordingNamePattern
          if ($recordingNamePattern) {
            $recordingNamePattern = $recordingNamePattern.ToString().Trim()
          }
          if (-not [string]::IsNullOrWhiteSpace($recordingNamePattern)) {
            $payload.recordingNamePattern = $recordingNamePattern
          }
        }
        if ($data.PSObject.Properties.Name -contains "signalBase") {
          $signalBase = $data.signalBase
          if ($signalBase) {
            $signalBase = $signalBase.ToString().Trim()
          }
          if (-not [string]::IsNullOrWhiteSpace($signalBase)) {
            $payload.signalBase = $signalBase
          }
        }
        if ($data.PSObject.Properties.Name -contains "mediaBase") {
          $mediaBase = $data.mediaBase
          if ($mediaBase) {
            $mediaBase = $mediaBase.ToString().Trim()
          }
          if (-not [string]::IsNullOrWhiteSpace($mediaBase)) {
            $payload.mediaBase = $mediaBase
          }
        }
        if ($data.PSObject.Properties.Name -contains "forceHttps") {
          $payload.forceHttps = [bool]$data.forceHttps
        }
        if ($data.PSObject.Properties.Name -contains "logsVerbose") {
          $payload.logsVerbose = [bool]$data.logsVerbose
        }
        if ($data.PSObject.Properties.Name -contains "motionDefaults") {
          $motionPayload = @{}
          $motionDefaults = $data.motionDefaults
          if ($motionDefaults) {
            if ($motionDefaults.PSObject.Properties.Name -contains "enabled") {
              $motionPayload.enabled = [bool]$motionDefaults.enabled
            }
            if ($motionDefaults.PSObject.Properties.Name -contains "sensitivity") {
              $motionPayload.sensitivity = [int]$motionDefaults.sensitivity
            }
            if ($motionDefaults.PSObject.Properties.Name -contains "stopAfter") {
              $motionPayload.stopAfter = [int]$motionDefaults.stopAfter
            }
          }
          if ($motionPayload.Count -gt 0) {
            $payload.motionDefaults = $motionPayload
          }
        }
        if ($payload.Count -eq 0) {
          if (Test-Path $serverConfigFile) {
            Remove-Item -Path $serverConfigFile -Force
          }
          $config = Get-ServerConfig -DefaultRecordingsDir $defaultRecordingsDir
          Send-JsonResponse -Response $response -StatusCode 200 -Payload $config
          continue
        }
        try {
          Write-ServerConfig -FilePath $serverConfigFile -Config $payload
        } catch {
        Send-JsonResponse -Response $response -StatusCode 500 -Payload @{ error = "save failed" }
        continue
      }
      $config = Get-ServerConfig -DefaultRecordingsDir $defaultRecordingsDir
      Send-JsonResponse -Response $response -StatusCode 200 -Payload $config
      continue
    }

    Send-EmptyResponse -Response $response -StatusCode 405
    continue
  }

  if ($requestPath -eq "/mediamtx/status") {
    if ($request.HttpMethod -eq "GET") {
      $config = Get-ServerConfig -DefaultRecordingsDir $defaultRecordingsDir
      $mediaBase = $config.mediaBase
      if ([string]::IsNullOrWhiteSpace($mediaBase)) {
        $mediaBase = Get-DefaultMediaBase -Request $request
      }
      $status = Test-MediaBaseStatus -BaseUrl $mediaBase
      Send-JsonResponse -Response $response -StatusCode 200 -Payload @{
        ok = $status.ok
        status = $status.status
        baseUrl = $mediaBase
      }
      continue
    }
    Send-EmptyResponse -Response $response -StatusCode 405
    continue
  }

  if ($requestPath -eq "/mediamtx/log") {
    if ($request.HttpMethod -eq "GET") {
      if (-not (Test-Path $mediamtxLogFile)) {
        Send-TextResponse -Response $response -StatusCode 404 -Text "log not found"
        continue
      }
      $text = Get-Content -Path $mediamtxLogFile -Raw -Encoding UTF8
      Send-TextResponse -Response $response -StatusCode 200 -Text $text
      continue
    }
    Send-EmptyResponse -Response $response -StatusCode 405
    continue
  }

  if ($requestPath -eq "/mediamtx/err") {
    if ($request.HttpMethod -eq "GET") {
      if (-not (Test-Path $mediamtxErrLogFile)) {
        Send-TextResponse -Response $response -StatusCode 404 -Text "log not found"
        continue
      }
      $text = Get-Content -Path $mediamtxErrLogFile -Raw -Encoding UTF8
      Send-TextResponse -Response $response -StatusCode 200 -Text $text
      continue
    }
    Send-EmptyResponse -Response $response -StatusCode 405
    continue
  }

  if ($requestPath -eq "/recordings") {
    if ($request.HttpMethod -eq "OPTIONS") {
      Send-EmptyResponse -Response $response -StatusCode 204
      continue
    }

    if ($request.HttpMethod -eq "POST") {
      $config = Get-ServerConfig -DefaultRecordingsDir $defaultRecordingsDir
      $recordingsDirResolved = $config.recordingsDirResolved
      if (-not (Test-Path $recordingsDirResolved)) {
        New-Item -ItemType Directory -Path $recordingsDirResolved -Force | Out-Null
      }
      $filenameHeader = $request.Headers["X-Filename"]
      $safeName = Get-SafeFilename -Name $filenameHeader -ContentType $request.ContentType
      $targetPath = Join-Path $recordingsDirResolved $safeName
      $targetPath = Get-UniquePath -Path $targetPath
      $fileStream = $null
      try {
        $fileStream = [System.IO.File]::Open($targetPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        $request.InputStream.CopyTo($fileStream)
      } catch {
        if ($fileStream) {
          $fileStream.Close()
        }
        Send-JsonResponse -Response $response -StatusCode 500 -Payload @{ error = "save failed" }
        continue
      } finally {
        if ($fileStream) {
          $fileStream.Close()
        }
      }
      $savedName = [System.IO.Path]::GetFileName($targetPath)
      Send-JsonResponse -Response $response -StatusCode 200 -Payload @{ ok = $true; name = $savedName }
      continue
    }

    Send-EmptyResponse -Response $response -StatusCode 405
    continue
  }

  $relativePath = $request.Url.AbsolutePath.TrimStart("/")
  if ([string]::IsNullOrWhiteSpace($relativePath)) {
    $relativePath = "index.html"
  }

  $filePath = Join-Path $resolvedRoot $relativePath
  if (-not (Test-Path $filePath -PathType Leaf)) {
    $response.StatusCode = 404
    $bytes = [System.Text.Encoding]::UTF8.GetBytes("Not found")
    $response.OutputStream.Write($bytes, 0, $bytes.Length)
    $response.OutputStream.Close()
    continue
  }

  $ext = [System.IO.Path]::GetExtension($filePath).ToLower()
  $contentType = $mimeTypes[$ext]
  if (-not $contentType) {
    $contentType = "application/octet-stream"
  }

  $bytes = [System.IO.File]::ReadAllBytes($filePath)
  $response.ContentType = $contentType
  $response.ContentLength64 = $bytes.Length
  $response.OutputStream.Write($bytes, 0, $bytes.Length)
  $response.OutputStream.Close()
}

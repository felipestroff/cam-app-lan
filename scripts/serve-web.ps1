param(
  [string]$Root = (Join-Path $PSScriptRoot "..\\web"),
  [int]$Port = 5173,
  [string]$HostName = "localhost"
)

$resolvedRoot = Resolve-Path $Root
$listener = [System.Net.HttpListener]::new()
$prefix = "http://${HostName}:$Port/"
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
$cameraTimeoutSeconds = 30

function Add-CorsHeaders {
  param([System.Net.HttpListenerResponse]$Response)
  $Response.Headers["Access-Control-Allow-Origin"] = "*"
  $Response.Headers["Access-Control-Allow-Headers"] = "Content-Type"
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

function Read-JsonBody {
  param([System.Net.HttpListenerRequest]$Request)
  $reader = New-Object System.IO.StreamReader($Request.InputStream, $Request.ContentEncoding)
  $body = $reader.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($body)) {
    return $null
  }
  return $body | ConvertFrom-Json
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
      foreach ($path in $rooms.Keys) {
        $room = $rooms[$path]
        $lastSeen = $room.LastSeen
        $isStale = $true
        if ($lastSeen) {
          $age = ($now - $lastSeen).TotalSeconds
          $isStale = $age -gt $cameraTimeoutSeconds
        }
        if ($isStale) {
          $stalePaths += $path
          continue
        }
        $items += @{
          id = $(if ($room.Id) { $room.Id } else { $path })
          name = $room.Name
          path = $path
          active = [bool]$room.Offer
          updated = $room.Updated.ToString("o")
          lastSeen = $(if ($room.LastSeen) { $room.LastSeen.ToString("o") } else { $null })
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

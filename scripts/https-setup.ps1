param(
  [int]$Port = 5173,
  [string]$IpAddress = "",
  [string[]]$DnsNames = @("localhost"),
  [string]$FriendlyName = "Cam App LAN"
)

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Error "Execute este script como Administrador."
  exit 1
}

$dnsNamesClean = $DnsNames | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique
$sanParts = @()
foreach ($name in $dnsNamesClean) {
  $sanParts += "dns=$name"
}
if (-not [string]::IsNullOrWhiteSpace($IpAddress)) {
  $sanParts += "ipaddress=$IpAddress"
}
$sanText = $null
if ($sanParts.Count -gt 0) {
  $sanText = "2.5.29.17={text}" + ($sanParts -join "&")
}

$certParams = @{
  CertStoreLocation = "cert:\LocalMachine\My"
  FriendlyName = $FriendlyName
  KeyExportPolicy = "Exportable"
  NotAfter = (Get-Date).AddYears(5)
  Subject = "CN=$FriendlyName"
}
if ($sanText) {
  $certParams.TextExtension = $sanText
}

try {
  $cert = New-SelfSignedCertificate @certParams
} catch {
  Write-Error "Falha ao criar certificado: $($_.Exception.Message)"
  exit 1
}

if (-not $cert) {
  Write-Error "Falha ao criar certificado."
  exit 1
}

$thumbprint = $cert.Thumbprint
if ([string]::IsNullOrWhiteSpace($thumbprint)) {
  Write-Error "Certificado criado sem thumbprint."
  exit 1
}

$rootPath = "cert:\LocalMachine\Root"
$exists = Get-ChildItem $rootPath | Where-Object { $_.Thumbprint -eq $thumbprint }
if (-not $exists) {
  $tempFile = Join-Path $env:TEMP "cam-app-$thumbprint.cer"
  Export-Certificate -Cert $cert -FilePath $tempFile | Out-Null
  Import-Certificate -FilePath $tempFile -CertStoreLocation $rootPath | Out-Null
  Remove-Item -Path $tempFile -Force -ErrorAction SilentlyContinue
}

$ipport = "0.0.0.0:$Port"
$appid = "{D0B16C1B-6F2B-4F8F-9A88-42A8E9A7C502}"
& netsh http delete sslcert ipport=$ipport | Out-Null
& netsh http add sslcert ipport=$ipport certhash=$thumbprint appid=$appid | Out-Null

Write-Host "HTTPS configurado para a porta $Port."
Write-Host "Thumbprint do certificado: $thumbprint"
Write-Host "Inicie o servidor com:"
Write-Host "  .\\scripts\\serve-web.ps1 -Root .\\web -Port $Port -HostName + -Scheme https"

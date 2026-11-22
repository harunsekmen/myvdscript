$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$port = 13943
$payload = Join-Path $env:RUNNER_TEMP 'script-atolyesi-updater'
New-Item -ItemType Directory -Force $payload | Out-Null
$newInstaller = Get-ChildItem 'src-tauri/target/release/bundle/nsis' -Filter '*_0.2.0_x64-setup.exe' | Select-Object -First 1
if (!$newInstaller) { throw '0.2.0 NSIS installer missing' }
$sig = (Get-Content -Raw "$($newInstaller.FullName).sig").Trim()
Copy-Item $newInstaller.FullName (Join-Path $payload 'setup.exe')
@{
  version = '0.2.0'
  platforms = @{
    'windows-x86_64-nsis' = @{ signature = $sig; url = "http://127.0.0.1:$port/setup.exe" }
  }
} | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 (Join-Path $payload 'latest.json')

$config = @{
  version = '0.1.99'
  bundle = @{ createUpdaterArtifacts = $false }
  plugins = @{
    updater = @{
      endpoints = @("http://127.0.0.1:$port/latest.json")
      dangerousInsecureTransportProtocol = $true
      windows = @{ installMode = 'quiet' }
    }
  }
}
$config | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 (Join-Path $payload 'fixture.json')
npm run tauri build -- --debug --bundles nsis --features updater-smoke --config (Join-Path $payload 'fixture.json')
$oldInstaller = Get-ChildItem 'src-tauri/target/debug/bundle/nsis' -Filter '*_0.1.99_x64-setup.exe' | Select-Object -First 1
if (!$oldInstaller) { throw '0.1.99 NSIS installer missing' }
$install = Join-Path $payload 'installed'
Start-Process -FilePath $oldInstaller.FullName -ArgumentList @('/S', "/D=$install") -Wait
$exe = Join-Path $install 'script-atolyesi.exe'
if (!(Test-Path $exe)) { throw "Fixture not installed at $exe" }
$oldHash = (Get-FileHash $exe).Hash
$env:SCRIPT_ATOLYESI_UPDATE_SMOKE_RESULT = Join-Path $payload 'result.txt'
$listener = Start-Process -FilePath python -ArgumentList @('-m', 'http.server', $port, '--bind', '127.0.0.1', '--directory', $payload) -PassThru
try {
  for ($i = 0; $i -lt 25; $i++) {
    try {
      Invoke-WebRequest "http://127.0.0.1:$port/latest.json" -ErrorAction Stop | Out-Null
      break
    } catch {
      Start-Sleep -Milliseconds 400
    }
  }
  Start-Process -FilePath $exe -ArgumentList '--verify-windows-updater'
  $ready = $false
  $result = ''
  for ($i = 0; $i -lt 150; $i++) {
    if (Test-Path $env:SCRIPT_ATOLYESI_UPDATE_SMOKE_RESULT) {
      $result = Get-Content -Raw $env:SCRIPT_ATOLYESI_UPDATE_SMOKE_RESULT
      if ($result.StartsWith('error')) { throw $result }
    }
    if (Test-Path $exe) {
      try {
        $updated = (Get-FileHash $exe).Hash -ne $oldHash
        $restarted = Get-Process script-atolyesi -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe }
        if ($updated -and $restarted) { $ready = $true; break }
      } catch {
        # The installer can replace the binary between Test-Path and Get-FileHash.
      }
    }
    Start-Sleep -Seconds 2
  }
  if (!$ready -or $result -ne 'signature_verified') { throw "Signed update did not complete and relaunch: $result" }
  Write-Host 'Signed NSIS update from 0.1.99 to 0.2.0 installed and relaunched.'
} finally {
  Stop-Process -Id $listener.Id -ErrorAction SilentlyContinue
  Get-Process script-atolyesi -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe } | Stop-Process -Force
}

$ErrorActionPreference = 'Stop'
$installer = Get-ChildItem apps/desktop-tauri/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/*-setup.exe | Select-Object -First 1
if (-not $installer) { throw 'Missing NSIS installer' }
$destination = Join-Path $env:RUNNER_TEMP 'zsir-cut-installed'
$install = Start-Process -FilePath $installer.FullName -ArgumentList @('/S', "/D=$destination") -Wait -PassThru
if ($install.ExitCode -ne 0) { throw "NSIS installation failed: $($install.ExitCode)" }
node scripts/smoke-release.mjs (Join-Path $destination 'runtime')
if ($LASTEXITCODE -ne 0) { throw 'Installed resource smoke failed' }
$app = Start-Process -FilePath (Join-Path $destination 'zsir-cut.exe') -PassThru
$hostProcess = $null
try {
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Seconds 1
    $app.Refresh()
    if ($app.HasExited) { throw "Installed app exited: $($app.ExitCode)" }
    $hostProcess = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
      $_.ParentProcessId -eq $app.Id -and $_.ExecutablePath -eq (Join-Path $destination 'runtime\node.exe') -and $_.CommandLine -like '*packages*app-host*dist*index.js*'
    } | Select-Object -First 1
    if ($hostProcess) { break }
  }
  if (-not $hostProcess) { throw 'Installed app did not start its bundled host' }
  Start-Sleep -Seconds 3
  if (-not (Get-Process -Id $hostProcess.ProcessId -ErrorAction SilentlyContinue)) { throw 'Bundled host exited after launch' }
  Write-Host 'NSIS silent install and installed app host launch passed'
} finally {
  Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue
  if ($hostProcess) { Stop-Process -Id $hostProcess.ProcessId -Force -ErrorAction SilentlyContinue }
}

param(
    [string]$Serial = 'emulator-5580',
    [string]$Avd = 'dsh-api29',
    [string]$AssetDirectory = ''
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$startupMutex = [Threading.Mutex]::new($false, "Local\Bionilux-$Serial")
$startupMutexHeld = $false
try {
    try { $startupMutexHeld = $startupMutex.WaitOne([TimeSpan]::FromMinutes(6)) }
    catch [Threading.AbandonedMutexException] { $startupMutexHeld = $true }
    if (!$startupMutexHeld) { throw 'Another Linux startup did not finish within six minutes.' }
$evidence = Join-Path $repo 'target\independent-linux'
if (!$AssetDirectory) { $AssetDirectory = Join-Path $evidence 'assets' }
if (!(Test-Path -LiteralPath (Join-Path $AssetDirectory 'linux-release.json'))) {
    throw 'Missing local acceptance assets. Build them using tests/acceptance/build-standalone-assets.py first.'
}
if ($Serial -notmatch '^emulator-(\d+)$') { throw 'This launcher is scoped to an independent Android emulator.' }
$emulatorPort = $Matches[1]
function InvokeDeviceAdb([string[]]$Arguments) {
    & adb.exe -s $Serial @Arguments
    if ($LASTEXITCODE -ne 0) { throw "adb failed: $($Arguments -join ' ')" }
}
$state = & adb -s $Serial get-state 2>$null
if ($state -ne 'device') {
    $listed = (& adb devices 2>$null) -join "`n"
    if ($listed -notmatch "(?m)^$([regex]::Escape($Serial))\s") {
        $sdk = if ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } else { Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
        Start-Process -FilePath (Join-Path $sdk 'emulator\emulator.exe') -ArgumentList @('-avd',$Avd,'-port',$emulatorPort,'-no-snapshot-save','-no-audio','-gpu','swiftshader_indirect','-memory','4096') -WindowStyle Hidden
    }
    $bootDeadline = (Get-Date).AddMinutes(3)
    do {
        Start-Sleep -Seconds 2
        $boot = & adb -s $Serial shell getprop sys.boot_completed 2>$null
        if ((Get-Date) -gt $bootDeadline) { throw 'Emulator boot timed out.' }
    } until (([string]$boot).Trim() -eq '1')
}
if ((& adb -s $Serial emu avd name | Select-Object -First 1).Trim() -ne $Avd) {
    throw "The device at $Serial is not the expected AVD $Avd."
}
$bootDeadline = (Get-Date).AddMinutes(3)
while ((& adb -s $Serial shell getprop sys.boot_completed 2>$null) -ne '1') {
    if ((Get-Date) -gt $bootDeadline) { throw 'Android boot did not finish.' }
    Start-Sleep -Seconds 2
}
InvokeDeviceAdb @('forward','tcp:19790','tcp:18790')
try {
    $health = Invoke-RestMethod 'http://127.0.0.1:19790/health' -TimeoutSec 3
    if ($health.ready) { Write-Output 'Linux is ready. Use node scripts/linux-agent.mjs exec <command>.'; exit 0 }
} catch { }

$sourceArchive = Join-Path $evidence 'source.tar'
& tar -cf $sourceArchive -C $repo packages/linux-bootstrap/src packages/linux-runtime/lib packages/linux-runtime/modules tests/acceptance/standalone-device.mjs tests/acceptance/standalone-download-server.mjs
if ($LASTEXITCODE -ne 0) { throw 'Source archive creation failed.' }
InvokeDeviceAdb @('shell','mkdir','-p','/data/local/tmp/bn-independent-assets')
$manifestFile = Join-Path $AssetDirectory 'linux-release.json'
$manifest = Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json
$assetNames = @('linux-release.json') + @($manifest.plugins.bootstrap.url, $manifest.plugins.runtime.url) + @($manifest.runtimes | ForEach-Object { $_.backendAsset.url; $_.rootfsAsset.url; $_.nodeAsset.url })
$assetNames = $assetNames | ForEach-Object { if ($_ -eq 'linux-release.json') { $_ } else { [IO.Path]::GetFileName(([Uri]$_).AbsolutePath) } } | Select-Object -Unique
foreach ($name in $assetNames) {
    InvokeDeviceAdb @('push',(Join-Path $AssetDirectory $name),"/data/local/tmp/bn-independent-assets/$name")
}
InvokeDeviceAdb @('push',$sourceArchive,'/data/local/tmp/bn-independent-source.tar')
InvokeDeviceAdb @('shell','run-as','com.dsharnessmobile.shell','mkdir','-p','files/independent-linux/src','files/independent-linux/logs','files/independent-linux/workspace')
foreach ($name in $assetNames) {
    InvokeDeviceAdb @('shell','run-as','com.dsharnessmobile.shell','/system/bin/cp',"/data/local/tmp/bn-independent-assets/$name",'files/independent-linux/')
}
InvokeDeviceAdb @('shell','run-as','com.dsharnessmobile.shell','/system/bin/tar','--no-same-owner','-xf','/data/local/tmp/bn-independent-source.tar','-C','files/independent-linux/src')
$launchFile = Join-Path $evidence 'start-device.sh'
$launch = @'
#!/system/bin/sh
set -eu
APP=/data/user/0/com.dsharnessmobile.shell
export BN_FIXTURE=$APP/files/independent-linux
export BN_SOURCE_ROOT=$BN_FIXTURE/src
export BN_APP=$APP
export BN_PACKAGE=com.dsharnessmobile.shell
export BN_EXPECT_UID=$(id -u)
export PREFIX=$APP/files/usr
export LD_LIBRARY_PATH=$PREFIX/lib
export PATH=$PREFIX/bin:/system/bin
export HOME=$APP/files/home
export TMPDIR=$PREFIX/tmp
exec "$PREFIX/bin/node" "$BN_SOURCE_ROOT/tests/acceptance/standalone-device.mjs" --serve
'@
[IO.File]::WriteAllText($launchFile, ($launch -replace "`r`n","`n") + "`n", [Text.UTF8Encoding]::new($false))
InvokeDeviceAdb @('push',$launchFile,'/data/local/tmp/bn-independent-start.sh')
InvokeDeviceAdb @('shell','run-as','com.dsharnessmobile.shell','cp','/data/local/tmp/bn-independent-start.sh','files/independent-linux/start.sh')
InvokeDeviceAdb @('shell',"run-as com.dsharnessmobile.shell /system/bin/sh -c 'if [ -f files/independent-linux/logs/standalone-device-install.json ]; then mv -f files/independent-linux/logs/standalone-device-install.json files/independent-linux/logs/standalone-device-install.previous.json; fi'")
InvokeDeviceAdb @('shell',"run-as com.dsharnessmobile.shell /system/bin/sh -c 'nohup /system/bin/sh files/independent-linux/start.sh > files/independent-linux/logs/service.log 2>&1 < /dev/null &'" )
Write-Output 'Linux service started; waiting for installation and health checks.'
$readyDeadline = (Get-Date).AddMinutes(6)
do {
    Start-Sleep -Seconds 2
    try {
        $health = Invoke-RestMethod 'http://127.0.0.1:19790/health' -TimeoutSec 3
        if ($health.ready) { Write-Output 'Linux is ready. Use node scripts/linux-agent.mjs exec <command>.'; exit 0 }
    } catch { }
    $installResult = (& adb -s $Serial shell "run-as com.dsharnessmobile.shell /system/bin/sh -c 'if [ -f files/independent-linux/logs/standalone-device-install.json ]; then cat files/independent-linux/logs/standalone-device-install.json; fi'" 2>$null) -join "`n"
    if ($installResult) {
        $report = $installResult | ConvertFrom-Json
        if ($report.passed -eq $false) { throw "Linux installation failed: $($report.failure.message)" }
    }
    if ((Get-Date) -gt $readyDeadline) {
        InvokeDeviceAdb @('shell','run-as','com.dsharnessmobile.shell','tail','-n','15','files/independent-linux/logs/service.log')
        throw 'Linux did not become healthy; see the device log above.'
    }
} while ($true)
} finally {
    if ($startupMutexHeld) { $startupMutex.ReleaseMutex() }
    $startupMutex.Dispose()
}

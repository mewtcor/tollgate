# Launch, check and tear down an isolated Eero Widget instance wired to a fake Eero server.
#   powershell -NoProfile -File verify.ps1 doctor|start|stop
# The instance builds under a different app identifier, so it has its own data dir, WebView2 profile and
# single-instance lock. It never touches a real Eero Widget the user may have running.
param([Parameter(Mandatory)][ValidateSet('doctor', 'start', 'stop')][string]$Cmd)

$root = (Resolve-Path "$PSScriptRoot\..\..\..\..").Path
$work = "$root\.verify"
$state = "$work\run.json"
$mockPort = 8787
$cdpPort = 9333
$ident = 'dev.mewt.eero-widget.verify'
$exe = "$root\target-verify\debug\tollgate.exe"
$cdp = "$PSScriptRoot\cdp.mjs"

function Alive($id) { [bool]($id -and (Get-Process -Id $id -ErrorAction SilentlyContinue)) }
function PortBusy($p) { [bool](Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue) }
function Wipe-Data {
    Remove-Item "$env:APPDATA\$ident", "$env:LOCALAPPDATA\$ident" -Recurse -Force -ErrorAction SilentlyContinue
}

function Do-Stop {
    if (Test-Path $state) {
        $r = Get-Content $state -Raw | ConvertFrom-Json
        # kill only what this run started: the app must still be our verify build
        $app = Get-Process -Id $r.app -ErrorAction SilentlyContinue
        if ($app -and $app.Path -eq $exe) { taskkill /PID $r.app /T /F | Out-Null }
        if (Alive $r.mock) { Stop-Process -Id $r.mock -Force }
        Remove-Item $state -Force
    }
    Start-Sleep -Milliseconds 500
    Wipe-Data
    Write-Output 'stopped (evidence under .verify\evidence is kept)'
}

function Do-Doctor {
    $bad = 0
    function Check($ok, $msg) { if ($ok) { Write-Output "ok:   $msg" } else { Write-Output "FAIL: $msg"; $script:bad++ } }
    $nodeMajor = [int](((node --version) -replace '^v', '').Split('.')[0])
    Check ($nodeMajor -ge 22) "node $nodeMajor (needs 22+ for global WebSocket)"
    Check ([bool](Get-Command cargo -ErrorAction SilentlyContinue)) 'cargo on PATH'
    if (-not (Test-Path $state)) {
        Check (-not (PortBusy $mockPort)) "port $mockPort free for the fake Eero server"
        Check (-not (PortBusy $cdpPort)) "port $cdpPort free for the debugger"
        Write-Output 'info: no run in progress (preflight only)'
    } else {
        $r = Get-Content $state -Raw | ConvertFrom-Json
        $app = Get-Process -Id $r.app -ErrorAction SilentlyContinue
        Check ($app -and $app.Path -eq $exe) "verify build is running (pid $($r.app))"
        Check (Alive $r.mock) "fake Eero server is running (pid $($r.mock))"
        $s = try { Invoke-RestMethod "http://127.0.0.1:$mockPort/__state" } catch { $null }
        Check ($null -ne $s) 'fake Eero server answers /__state'
        $t = node $cdp targets 2>$null
        Check ($LASTEXITCODE -eq 0 -and $t -match 'Tollgate') 'debugger sees the Tollgate page'
    }
    if ($bad) { exit 1 }
}

function Do-Start {
    if (Test-Path $state) { throw 'a run is already recorded in .verify\run.json. Run stop first.' }
    foreach ($p in $mockPort, $cdpPort) { if (PortBusy $p) { throw "port $p is busy, not starting" } }
    New-Item -ItemType Directory -Force "$work\evidence" | Out-Null
    Wipe-Data

    $env:CARGO_TARGET_DIR = "$root\target-verify"
    $env:TAURI_CONFIG = "{`"identifier`":`"$ident`"}"
    Push-Location $root
    cargo build
    $built = $LASTEXITCODE
    Pop-Location
    if ($built -ne 0) { throw 'cargo build failed' }

    $mock = Start-Process node -ArgumentList "`"$PSScriptRoot\mock-eero.mjs`"", $mockPort -PassThru `
        -RedirectStandardOutput "$work\mock.log" -RedirectStandardError "$work\mock.err"
    $env:EERO_HOST = "http://127.0.0.1:$mockPort"
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$cdpPort"
    $app = Start-Process $exe -PassThru -RedirectStandardOutput "$work\app.log" -RedirectStandardError "$work\app.err"
    @{ app = $app.Id; mock = $mock.Id } | ConvertTo-Json | Set-Content $state

    # ready means the login screen is showing, not just that the process is up
    $deadline = (Get-Date).AddSeconds(90)
    $ready = $false
    while ((Get-Date) -lt $deadline -and -not $ready) {
        Start-Sleep -Milliseconds 700
        node $cdp wait "document.readyState === 'complete' && !document.querySelector('#login').hidden" 1500 2>$null
        $ready = ($LASTEXITCODE -eq 0)
    }
    if (-not $ready) { Do-Stop; throw 'app never showed the login screen within 90s' }
    Write-Output "ready: app pid $($app.Id), fake Eero on $mockPort, debugger on $cdpPort"
}

switch ($Cmd) { 'doctor' { Do-Doctor } 'start' { Do-Start } 'stop' { Do-Stop } }

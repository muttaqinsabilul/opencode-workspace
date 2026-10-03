param(
    [string]$Project,
    [int]$Port,
    [string]$Bind,
    [string]$SkillsBase,
    [switch]$Copy
)

# Opencode Workspace -- one-command first run (Windows native, no bash needed).
#   powershell -File setup.ps1 [-Project DIR] [-Port N] [-Bind ADDR] [-Copy] [-SkillsBase DIR]
# Same three steps as setup.sh: detect, install the skill, start the server.
# Differences from setup.sh (see README): Node 18+ only (no PHP fallback),
# forwards -Port/-Bind only, server opens in its own window (close it to stop).
# -Copy installs a plain folder copy instead of a symlink (re-run after updates).
# -SkillsBase overrides the skills root (default: $HOME\.config, honours the
# same layout as XDG_CONFIG_HOME on other platforms).
# After this, just ask OpenCode: run workspace

$Root = $PSScriptRoot
$Skill = Join-Path $Root 'skills\opencode-workspace'
$Launcher = Join-Path $Root 'workspace.ps1'

function Fail([string]$msg) {
    [Console]::Error.WriteLine("Opencode Workspace: $msg")
    exit 1
}

if (-not (Test-Path -LiteralPath $Skill)) { Fail "skill folder missing: $Skill (is this the full clone?)" }
if (-not (Test-Path -LiteralPath $Launcher)) { Fail "launcher missing: $Launcher" }

try {
    if ($Project) { $ProjPath = (Resolve-Path -LiteralPath $Project -ErrorAction Stop).Path }
    else { $ProjPath = (Get-Location -ErrorAction Stop).Path }
}
catch { Fail "project folder not found: $Project" }
$rootNorm = $Root.TrimEnd('\')
$projNorm = $ProjPath.TrimEnd('\')
if ($projNorm -eq $rootNorm -or $projNorm.StartsWith($rootNorm + '\', [StringComparison]::OrdinalIgnoreCase)) {
    Fail "this watches the clone itself -- run setup.ps1 from your project or pass -Project <your-project>"
}
if ($PSBoundParameters.ContainsKey('Port') -and ($Port -lt 1024 -or $Port -gt 65535)) {
    Fail "port must be 1024-65535: $Port"
}
if (-not (Get-Command opencode -ErrorAction SilentlyContinue)) {
    Write-Output "Note: 'opencode' CLI not on PATH -- the dashboard starts anyway and fills up once OpenCode runs here."
}
$nodeOk = $false
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
    try { $major = [int]((node --version 2>$null) -replace '^v(\d+)\..*', '$1') }
    catch { $major = 0 }
    if ($major -ge 18) { $nodeOk = $true }
}
if (-not $nodeOk) {
    Fail "need Node 18+ on PATH (found: $(if ($node) { node --version } else { 'none' })). PHP fallback lives in setup.sh (Git Bash/WSL): bash setup.sh --php --project ""$ProjPath"""
}
Write-Output "Project : $ProjPath"
Write-Output "Runtime : node $(node --version)"

if (-not $SkillsBase) { $SkillsBase = Join-Path $HOME '.config' }
$Dest = Join-Path $SkillsBase 'opencode\skills\opencode-workspace'
New-Item -ItemType Directory -Force -Path (Split-Path $Dest) | Out-Null
$skillNorm = (Resolve-Path -LiteralPath $Skill).Path.TrimEnd('\')
# Get-Item -Force sees broken symlinks too (Test-Path follows the link and lies).
$existing = Get-Item -LiteralPath $Dest -Force -ErrorAction SilentlyContinue
$linkTarget = $null
if ($existing -and ($existing.LinkType -eq 'SymbolicLink' -or $existing.LinkType -eq 'Junction')) {
    try { $linkTarget = (Resolve-Path -LiteralPath $existing.Target -ErrorAction Stop).Path.TrimEnd('\') }
    catch { $linkTarget = $null }
}
if ($Copy) {
    Remove-Item -LiteralPath $Dest -Recurse -Force -ErrorAction SilentlyContinue
    Copy-Item -LiteralPath $Skill -Destination $Dest -Recurse -Force
    if (-not $?) { Fail "copy failed" }
    Write-Output "Skill   : copied to $Dest (re-run setup.ps1 -Copy after updating the clone)"
}
elseif ($existing -and $linkTarget -and ($linkTarget -eq $skillNorm)) {
    Write-Output "Skill   : already installed ($Dest)"
}
elseif ($existing) {
    Fail "$Dest already exists and is not this clone's link -- remove or back it up first, or pass -Copy"
}
else {
    try { New-Item -ItemType SymbolicLink -Path $Dest -Target $Skill -ErrorAction Stop | Out-Null }
    catch { Fail "cannot create a symlink (needs admin / Developer Mode) -- retry elevated or pass -Copy" }
    Write-Output "Skill   : linked $Dest"
}

# The launcher is a foreground server, so it opens in its own window (closing
# the window stops it) and setup keeps going: output lands in a temp log that
# is parsed for the real URL, then pinged before reporting success.
$Log = Join-Path ([IO.Path]::GetTempPath()) 'opencode-workspace-setup.log'
Remove-Item -LiteralPath $Log -ErrorAction SilentlyContinue
$launchArgs = @('-NoProfile', '-File', $Launcher, '-Project', $ProjPath)
if ($PSBoundParameters.ContainsKey('Port')) { $launchArgs += @('-Port', "$Port") }
if ($Bind) { $env:WORKSPACE_BIND = $Bind }
try { Start-Process -FilePath 'powershell' -ArgumentList $launchArgs -RedirectStandardOutput $Log -ErrorAction Stop | Out-Null }
catch { Fail "could not start the server window: $($_.Exception.Message) (log: $Log)" }

$url = $null
for ($i = 0; $i -lt 100 -and -not $url; $i++) {
    Start-Sleep -Milliseconds 150
    if (Test-Path -LiteralPath $Log) {
        $line = Select-String -LiteralPath $Log -Pattern 'opencode-workspace on (http://\S+/workspace)' -ErrorAction SilentlyContinue | Select-Object -Last 1
        if ($line) { $url = $line.Matches[0].Groups[1].Value }
    }
}
if (-not $url) { Fail "server did not report a URL within 15s (log: $Log)" }
try { $ping = (Invoke-WebRequest -UseBasicParsing "$url/api/ping" -TimeoutSec 5).StatusCode }
catch { $ping = 0 }
if ($ping -ne 200) { Fail "server URL $url does not answer yet (log: $Log) -- check the server window" }
Write-Output "URL     : $url"
Write-Output "Stop    : close the opencode-workspace server window"
Write-Output 'From now on, just ask OpenCode: run workspace'

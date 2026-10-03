param(
    [string]$Project,
    [int]$Port,
    [string]$SkillsBase,
    [switch]$Copy
)

# Opencode Workspace -- one-command first run (Windows native, no bash needed).
#   powershell -File setup.ps1 [-Project DIR] [-Port N] [-Copy]
# Same three steps as setup.sh: detect, link the skill, start the server.
# -Copy installs a plain folder copy instead of a symlink (re-run after updates).
# After this, just ask OpenCode: run workspace

$Root = $PSScriptRoot
$Skill = Join-Path $Root 'skills\opencode-workspace'
if (-not $SkillsBase) { $SkillsBase = Join-Path $HOME '.config' }
$Dest = Join-Path $SkillsBase 'opencode\skills\opencode-workspace'

if ($Project) { $ProjPath = (Resolve-Path -LiteralPath $Project).Path }
else { $ProjPath = (Get-Location).Path }
if ($ProjPath.TrimEnd('\') -eq $Root.TrimEnd('\')) {
    Write-Output 'Opencode Workspace: this watches the clone itself -- run setup.ps1 from your project'
    Write-Output '  or pass: powershell -File setup.ps1 -Project <your-project>'
    exit 1
}
if (-not (Get-Command opencode -ErrorAction SilentlyContinue)) {
    Write-Output "Note: 'opencode' CLI not on PATH -- the dashboard starts anyway and fills up once OpenCode runs here."
}
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Output 'Opencode Workspace: node not found -- workspace.ps1 needs Node 18+ (https://nodejs.org).' | Out-String | Write-Output
    exit 1
}
Write-Output "Project : $ProjPath"

New-Item -ItemType Directory -Force -Path (Split-Path $Dest) | Out-Null
if (Test-Path $Dest) {
    $link = Get-Item $Dest -ErrorAction SilentlyContinue
    if ($link.LinkType -eq 'SymbolicLink' -and $link.Target -eq $Skill) { Write-Output "Skill   : already installed ($Dest)" }
    else { Write-Output "Opencode Workspace: $Dest already exists and points elsewhere -- remove or back it up first."; exit 1 }
}
else {
    if ($Copy) {
        Copy-Item -Recurse -Force $Skill $Dest
        Write-Output "Skill   : copied to $Dest (re-run setup.ps1 -Copy after updating the clone)"
    }
    else {
        try { New-Item -ItemType SymbolicLink -Path $Dest -Target $Skill -ErrorAction Stop | Out-Null }
        catch {
            Write-Output 'Opencode Workspace: symlink needs admin / Developer Mode. Either retry elevated, pass -Copy for a plain copy, or copy the folder instead:'
            Write-Output "  Copy-Item -Recurse '$Skill' '$Dest'"
            exit 1
        }
        Write-Output "Skill   : linked $Dest"
    }
}

$wargs = @{ Project = $ProjPath }
if ($PSBoundParameters.ContainsKey('Port')) { $wargs['Port'] = $Port }
& (Join-Path $Root 'workspace.ps1') @wargs
if (-not $?) { exit 1 }
Write-Output 'From now on, just ask OpenCode: run workspace'

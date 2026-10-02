param(
    [int]$Port = 8788,
    [string]$Project
)

# An explicit -Port wins; otherwise inherit WORKSPACE_PORT; otherwise the default above.
if (-not $PSBoundParameters.ContainsKey('Port') -and $env:WORKSPACE_PORT) { $Port = [int]$env:WORKSPACE_PORT }
$env:WORKSPACE_PORT = "$Port"
# Unset means the current working directory, which is what the server falls back to.
if ($Project) { $env:WORKSPACE_PROJECT = (Resolve-Path -LiteralPath $Project).Path }
node "$PSScriptRoot\skills\opencode-workspace\runtime\bin\serve-node.mjs"

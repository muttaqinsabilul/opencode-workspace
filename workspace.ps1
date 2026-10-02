param(
    [int]$Port = 8800
)

$env:WORKSPACE_PORT = "$Port"
node "$PSScriptRoot\skills\opencode-workspace\runtime\bin\serve-node.mjs"

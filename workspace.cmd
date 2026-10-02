@echo off
setlocal
if not defined WORKSPACE_PORT set WORKSPACE_PORT=8800
node "%~dp0skills\opencode-workspace\runtime\bin\serve-node.mjs" %*

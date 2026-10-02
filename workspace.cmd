@echo off
setlocal
rem Direct launcher. Configuration is environment-only (serve-node.mjs never parses argv).
rem Unset WORKSPACE_PROJECT means the current working directory.
if not defined WORKSPACE_PORT set WORKSPACE_PORT=8788
node "%~dp0skills\opencode-workspace\runtime\bin\serve-node.mjs"

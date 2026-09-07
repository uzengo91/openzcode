@echo off
rem OpenZCode launcher (Windows)
setlocal
set DIR=%~dp0..
if exist "%DIR%\kernel\codex-rs\target\release\codex-tui.exe" (
  "%DIR%\kernel\codex-rs\target\release\codex-tui.exe" %*
  goto :eof
)
where openzcode >nul 2>nul && (openzcode %* & goto :eof)
where codex >nul 2>nul && (codex %* & goto :eof)
echo OpenZCode: kernel binary not found. Build: cd kernel\codex-rs ^&^& cargo build --release -p codex-tui
exit /b 1

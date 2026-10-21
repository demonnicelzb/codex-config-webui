@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Codex Web
echo.
echo   启动 Codex Web ...
echo.
node server.mjs %*
if errorlevel 1 (
  echo.
  echo   启动失败。请确认已安装 Node.js 18+（当前 PATH 中需要能找到 node）。
  echo.
  pause
)

@echo off
chcp 65001 >nul
title 囤囤鼠 bot - Node 决策进程
cd /d "%~dp0"
echo ========================================
echo  囤囤鼠 bot 启动中...
echo  桥接服务: ws://127.0.0.1:8787
echo  脚本端点: http://127.0.0.1:8790/bridge.js
echo ========================================
echo.
echo  注意: 保持此窗口开启，关闭即停止 bot。
echo.
npm run bridge
pause

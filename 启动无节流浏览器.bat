@echo off
chcp 65001 >nul
title 囤囤鼠 bot - 无节流浏览器
cd /d "%~dp0"

set "GAME_URL=https://grasp-rat-game.h-e.top/"
set "PROFILE=%LOCALAPPDATA%\grasp-rat-bot-chrome-profile"

REM 关键：这些参数关闭 Chromium 后台标签节流/休眠。
REM 没有它们时，标签页挂后台几分钟后主线程会被限速甚至冻结，游戏快照停止。
echo ========================================
echo  启动“无节流”浏览器专用于 bot 挂机
echo  配置目录: %PROFILE%
echo  游戏地址: %GAME_URL%
echo ========================================
echo.
echo  说明:
echo  1. 这是独立浏览器配置，不影响你日常浏览器。
echo  2. 请在这个窗口打开的浏览器里安装篡改猴，并导入 userscript。
echo  3. 可把该浏览器窗口最小化；尽量不要用“休眠标签/省内存”功能。
echo  4. 同时请保持 启动bot.bat / npm run bridge 在运行。
echo.

set "EDGE="
set "CHROME="

if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"

if defined CHROME goto :launch_chrome
if defined EDGE goto :launch_edge

echo [错误] 未找到 Edge 或 Chrome。
echo 请手动安装浏览器，或把下面参数加到你的浏览器快捷方式目标中:
echo   --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding
echo.
pause
exit /b 1

:launch_edge
echo 使用 Edge: %EDGE%
start "" "%EDGE%" --user-data-dir="%PROFILE%" --new-window --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling --no-first-run --no-default-browser-check --autoplay-policy=no-user-gesture-required "%GAME_URL%"
goto :done

:launch_chrome
echo 使用 Chrome: %CHROME%
start "" "%CHROME%" --user-data-dir="%PROFILE%" --new-window --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling --no-first-run --no-default-browser-check --autoplay-policy=no-user-gesture-required "%GAME_URL%"
goto :done

:done
echo.
echo 浏览器已启动。本窗口可关闭。
ping 127.0.0.1 -n 4 >nul

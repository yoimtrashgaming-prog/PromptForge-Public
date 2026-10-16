@echo off
REM Start PromptForge on the Windows dev box.
REM
REM Double-click this, or the desktop shortcut that points at it. A console
REM window opens and stays open while the server runs; closing it stops the
REM server. A browser tab opens once the server is answering. Same shape as
REM ComfyUI's launcher.
REM
REM node is called DIRECTLY rather than through npm on purpose. `npm start`
REM spawns node as a grandchild, and closing the console window can leave that
REM node process orphaned and still holding port 8090 - which is how you end up
REM talking to a server you thought you had closed.
REM
REM The two Ollama variables below are why this file exists. Do NOT use them
REM on a Pascal card such as the Tesla P40: it has neither flash attention nor
REM a q8_0 KV cache. See start.sh.

REM This file re-invokes itself as "--open-when-ready <port>" to open the
REM browser. node below owns this console until the server stops, so the wait
REM cannot happen inline. See the label at the bottom.
if /i "%~1"=="--open-when-ready" goto open_when_ready

setlocal
title PromptForge server - close this window to stop it
cd /d "%~dp0"

set OLLAMA_FLASH_ATTENTION=1
set OLLAMA_KV_CACHE_TYPE=q8_0

REM Held in one place because the message below and the browser helper must
REM agree. config/server.yaml is not read here, so a port changed only in the
REM YAML would still be announced - and opened - as this one.
set PF_PORT=8090
if defined PROMPTFORGE_PORT set PF_PORT=%PROMPTFORGE_PORT%

echo.
echo   PromptForge starting - http://localhost:%PF_PORT%
echo   Close this window to stop the server.
echo.

start "" /b cmd /c ""%~f0" --open-when-ready %PF_PORT%"

node server.mjs

REM Only reached if the server exits. A crash would otherwise close the window
REM instantly and take the error message with it.
if errorlevel 1 (
  echo.
  echo   The server stopped with an error. The lines above say why.
  pause
)
exit /b

:open_when_ready
REM Waits for the server to actually answer before opening a tab, rather than
REM racing it and showing "can't reach this page" - loading the tag database
REM makes the first boot the slow one.
REM
REM Any HTTP reply means it is up. Signed out, / returns the login page, and
REM even a 401 proves something is listening; curl exits non-zero only when the
REM connection itself failed, which is the condition being waited on.
REM
REM The probe says 127.0.0.1 and the browser is sent to localhost, on purpose.
REM localhost resolves to ::1 first on this box and the server binds IPv4 only,
REM so probing localhost burns the whole --max-time on IPv6 every attempt and
REM never succeeds - which is exactly how the first version of this shipped
REM broken. The browser still gets localhost because the session cookie is
REM scoped to the host name, and 127.0.0.1 is a different origin that would
REM land you on a login page you had already passed.
REM
REM Gives up quietly after ~60 tries. A launcher that opens no tab is a small
REM annoyance; one that pops an error over a working server is worse.
setlocal
set PF_PORT=%~2
if not defined PF_PORT set PF_PORT=8090
set PF_TRIES=0

:open_wait
curl -s -o nul --max-time 2 http://127.0.0.1:%PF_PORT%/ && goto open_now
set /a PF_TRIES+=1
if %PF_TRIES% geq 60 exit /b 0
ping -n 2 127.0.0.1 >nul
goto open_wait

:open_now
start "" http://localhost:%PF_PORT%
exit /b 0

@echo off
rem Launcher for build-widgets.sh - double-click this, or run it from PowerShell.
rem
rem It exists to force GIT Bash. `bash` on PATH is C:\Windows\system32\bash.exe,
rem which is WSL: different filesystem paths and no zet installed, so the build
rem fails there in a way that looks like the script is broken.

setlocal
set "SH="
for %%P in (
  "%ProgramFiles%\Git\bin\bash.exe"
  "%ProgramFiles(x86)%\Git\bin\bash.exe"
  "%LOCALAPPDATA%\Programs\Git\bin\bash.exe"
) do if not defined SH if exist %%P set "SH=%%~P"

if not defined SH (
  echo Could not find Git Bash. Install Git for Windows, or run build-widgets.sh
  echo from a Git Bash prompt yourself.
  exit /b 1
)

"%SH%" -lc "cd \"$(dirname \"$0\")\" && ./build-widgets.sh %*" "%~f0"
set "RC=%ERRORLEVEL%"

rem Always pause, so a double-clicked window cannot vanish before the summary
rem can be read. There is no reliable way to tell a double-click from a
rem PowerShell call - both arrive as `cmd /c "<this file> ..."` - and a guess
rem that is wrong half the time is worse than a rule you can predict.
rem Chaining this in another script? Call build-widgets.sh through Git Bash
rem directly; it does not pause.
echo.
pause

exit /b %RC%

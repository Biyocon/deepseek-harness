@echo off
title DeepSeek Harness Desktop
set DSH_HOME=C:\Users\Biyocon\.dsh
cd /d "C:\Users\Biyocon\Deepseek"

REM Check if server is already running
echo Checking if DeepSeek Harness is already running...
for /f "tokens=1" %%p in ('netstat -ano ^| findstr 3082') do (
    echo DeepSeek Harness is already running on port 3082 (PID: %%p)
    exit /b
)

echo Starting DeepSeek Harness Web UI...
start http://127.0.0.1:3082

REM Launch the server in background
start "DeepSeek Server" cmd /c "cd /d C:\Users\Biyocon\Deepseek && pnpm dsh web --port 3082"

echo DeepSeek Harness started at http://127.0.0.1:3082
echo Press any key to close this window...
pause
# How to Pin DeepSeek Harness to Taskbar

To pin the DeepSeek harness web interface to your taskbar for easy access, follow these steps:

## Method 1: Pin the Web Interface Directly

Since the DeepSeek harness runs a local web server, you can create a shortcut and pin it to your taskbar.

### Step-by-Step Guide:

1. **Create a Batch File** (to make it easier to start):
   
   Create a file called `start-deepseek.bat` in your DeepSeek directory (`C:\Users\Biyocon\Deepseek`) with the following content:
   ```batch
   @echo off
   cd /d "C:\Users\Biyocon\Deepseek"
   echo Starting DeepSeek Harness Web UI...
   start http://127.0.0.1:3080
   pnpm dsh web
   ```

2. **Create a Shortcut to the Batch File**:
   - Right-click on your Desktop or in a folder
   - Select "New" → "Shortcut"
   - Enter the path: `C:\Users\Biyocon\Deepseek\start-deepseek.bat`
   - Click "Next" and name it "DeepSeek Harness"
   - Click "Finish"

3. **Pinning to Taskbar**:
   - Right-click on your newly created shortcut
   - Select "Pin to Taskbar"
   
## Method 2: Pin Directly to the Web UI

1. **Start DeepSeek at least once**:
   ```cmd
   cd C:\Users\Biyocon\Deepseek
   pnpm dsh web
   ```

2. **Open your browser and navigate to the interface**:
   - Open your web browser
   - Go to `http://127.0.0.1:3080`

3. **Pin the website to your taskbar**:
   - In your browser, click on the address bar
   - Drag the URL to your taskbar or right-click and select "Pin Site to Taskbar"
   - Note: This works in some browsers but not all

## Method 3: Create a Desktop Application Launcher

If you want a more native experience, create a simple launcher:

1. **Create PowerShell Script** (`deepseek-launcher.ps1`):
   ```powershell
   # Set working directory to DeepSeek
   Set-Location "C:\Users\Biyocon\Deepseek"
   
   # Start the web UI in background
   Start-Process -FilePath "pnpm" -ArgumentList "dsh web" -WindowStyle Hidden
   
   # Wait a moment for server to start (adjust time as needed)
   Start-Sleep -Seconds 3
   
   # Open in default browser
   Start-Process "http://127.0.0.1:3080"
   ```

2. **Save the PowerShell script** in your DeepSeek directory 

3. **Create shortcut to this PowerShell script** and pin it to the taskbar

## Alternative: Use Task Scheduler

If you want the DeepSeek server to start automatically on login:

1. Open Task Scheduler
2. Create a basic task that runs when you log in
3. Set the action to run:
   ```
   cmd /c "cd C:\Users\Biyocon\Deepseek && pnpm dsh web"
   ```

## Tips for Best Experience

1. **Keep server running**: When you start DeepSeek, leave it running. The taskbar pinned app will allow you to quickly open the browser.
   
2. **Use a browser with taskbar pinning support** - Edge and Chrome work best for pinning websites.

3. **Create desktop shortcuts** for quick access:
   ```
   Target: cmd /c "cd C:\Users\Biyocon\Deepseek && pnpm dsh web"
   Start in: C:\Users\Biyocon\Deepseek
   ```

4. **Adjust ports if needed**: If port 3080 is occupied, you can specify a different port:
   ```cmd
   pnpm dsh web --port 3081
   ```

## Troubleshooting

If the web server doesn't start:

1. Make sure you're in the correct directory:
   ```
   cd C:\Users\Biyocon\Deepseek
   ```

2. Check if dependencies are installed:
   ```
   pnpm install
   ```

3. Check if another process is using port 3080:
   ```
   netstat -ano | findstr :3080
   ```

4. Try a different port:
   ```
   pnpm dsh web --port 3081
   ```

## Accessing Your Pinned App

Once pinned, you can:
- Click the taskbar icon to quickly launch the DeepSeek web interface in your browser
- Right-click it to access additional options or close the application
- Hover over it to see recent usage (if supported by your system)

This approach gives you a persistent, quick-access way to start and use the DeepSeek harness as if it were a native desktop application.
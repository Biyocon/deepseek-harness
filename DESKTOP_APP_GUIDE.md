# Running DeepSeek Harness as a Desktop Application

The DeepSeek harness is primarily a development framework for building AI agents, not a traditional desktop application. However, it does provide a web-based interface that can be used locally on your desktop.

## Understanding the Architecture

DeepSeek Harness uses a plugin-based architecture where:
- Everything is a plugin
- It's powered by Cordis (a spatiotemporal composability framework)
- The Web UI is the main way to interact with it

## Available Desktop Options

### Option 1: Web Interface (Recommended)
The harness provides a web-based interface that runs locally:

```bash
# From the DeepSeek root directory
cd C:\Users\Biyocon\Deepseek
pnpm dsh web
```

This starts a local web server (usually at http://127.0.0.1:3080) where you can interact with the harness through your browser.

### Option 2: Desktop Application Wrapper (If Available)
Some projects create wrapper applications around web interfaces using tools like:
- Electron.js
- Tauri
- WebView libraries

However, the DeepSeek harness doesn't ship with an official desktop application wrapper. You would need to create one yourself or use a third-party tool.

### Option 3: Command Line Interface
The harness has CLI capabilities that can be used from the command line:

```bash
# Install globally (if you want to access it anywhere)
pnpm add -g @deepseek-ai/dsh

# Then run commands like:
dsh web          # Start web UI
dsh build        # Build the application
dsh help         # Show available commands
```

### Option 4: Integration with Desktop Environments
If you want to integrate with desktop environments:

1. Create a shortcut to run `pnpm dsh web`
2. Set up a desktop launcher that automatically starts the web server
3. Add it to your system startup programs

## Steps to Run Locally

1. **Open Command Prompt or PowerShell in the DeepSeek directory:**
   ```cmd
   cd C:\Users\Biyocon\Deepseek
   ```

2. **Start the Web UI (recommended approach):**
   ```cmd
   pnpm dsh web
   ```

3. **Access in your browser:**
   - Open your web browser and navigate to `http://127.0.0.1:3080`

## Creating a Desktop Shortcut

To create a desktop shortcut for easy access:

1. Right-click on your desktop
2. Select "New" → "Shortcut"
3. Enter the target path:
   ```
   cmd /k "cd C:\Users\Biyocon\Deepseek && pnpm dsh web"
   ```
4. Name the shortcut "DeepSeek Harness Web UI"
5. Click "Finish"

This way, you'll be able to start the DeepSeek harness with a simple double-click.

## Requirements

- Node.js (already installed as part of pnpm)
- pnpm package manager
- Web browser for the GUI interface

## Notes

- The harness doesn't include a native Windows desktop application by default
- It's designed to be extensible through plugins
- You can build custom components that could provide desktop-like functionality
- The web UI provides all core functionality of the harness

## Troubleshooting

If the web UI fails to start:

1. Make sure you're in the correct directory: `C:\Users\Biyocon\Deepseek`
2. Run: `pnpm install` (should already be done)
3. Try running: `pnpm dsh web --help` for options
4. Check that no other application is using port 3080

The DeepSeek harness provides a powerful agent development framework with a local web interface that can serve as your desktop application experience.
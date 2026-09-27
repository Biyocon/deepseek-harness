# Using Custom Kimi and Ollama Providers in DeepSeek Harness

This guide explains how to integrate and use custom Kimi and Ollama providers with your DeepSeek harness setup.

## Prerequisites

Before using these providers, ensure:
1. You have installed the DeepSeek harness
2. You have configured your local environment
3. You have API keys for services that require them (like Kimi)

## Setting Up Ollama Provider

### 1. Install Ollama
If you haven't already, install Ollama on your system:
- Download from: https://ollama.com/download
- Follow installation instructions for your platform

### 2. Pull Models
Download models you want to use with Ollama:
```bash
# Pull popular models
ollama pull llama3
ollama pull mistral
ollama pull phi3
```

### 3. Register in DeepSeek
Use the registration script provided:
```bash
cd C:\Users\Biyocon\Deepseek
node register-custom-providers.js
```

## Setting Up Kimi Provider

### 1. Get Kimi API Key
Visit https://www.kimi.ai/ to get your API key.

### 2. Configure Environment
Set your API key in environment variables:
```bash
# For Windows Command Prompt
set KIMI_API_KEY=your_actual_api_key_here

# For PowerShell  
$env:KIMI_API_KEY="your_actual_api_key_here"
```

### 3. Update Configuration
Modify your application to include the provider registration.

## Using in Agents

Once registered, you can use these providers in your agents:

### Example 1: Simple Prompt with Ollama
```typescript
import { ctx } from '@deepseek-ai/dsh-core';

// Using local Ollama model
const response = await ctx.llm.prepareCall({
  provider: 'ollama',
  model: 'llama3:latest',
  messages: [
    { role: 'user', content: 'Explain quantum computing in simple terms' }
  ],
  temperature: 0.7,
  maxTokens: 1000
});
```

### Example 2: Using Kimi AI
```typescript
import { ctx } from '@deepseek-ai/dsh-core';

// Using Kimi AI model
const kimiResponse = await ctx.llm.prepareCall({
  provider: 'kimi',
  model: 'kimi',
  messages: [
    { role: 'user', content: 'What are the latest developments in AI?' }
  ],
  temperature: 0.3,
  maxTokens: 1500
});
```

### Example 3: Provider Selection Based on Context
```typescript
import { ctx } from '@deepseek-ai/dsh-core';

// Choose provider based on task complexity
function selectProvider(taskComplexity) {
  if (taskComplexity > 8) {
    return 'kimi'; // For complex tasks requiring advanced reasoning
  } else {
    return 'ollama'; // For local processing
  }
}

const provider = selectProvider(9);
const response = await ctx.llm.prepareCall({
  provider: provider,
  model: provider === 'kimi' ? 'kimi' : 'llama3:text',
  messages: [
    { role: 'user', content: 'Analyze this data' }
  ]
});
```

## Configuration Options

### Ollama Provider Settings
```javascript
{
  "provider": "ollama",
  "baseUrl": "http://localhost:11434", // Default Ollama URL
  "defaultModel": "llama3:latest",
  "timeout": 30000, // Timeout in milliseconds
  "retryAttempts": 3 // Number of retry attempts
}
```

### Kimi Provider Settings  
```javascript
{
  "provider": "kimi",
  "apiKey": "your-api-key-here",
  "baseUrl": "https://api.kimi.ai",
  "defaultModel": "kimi", 
  "timeout": 60000,
  "retryAttempts": 3
}
```

## Best Practices

1. **Use Local Models for Development**: Ollama models are great for local development and testing
2. **Leverage Cloud Providers for Complex Tasks**: Kimi offers advanced capabilities for complex reasoning
3. **Monitor Resource Usage**: Local models use system resources - monitor CPU and memory 
4. **Handle Errors Gracefully**: Implement proper fallback strategies
5. **Cache Responses**: For repeated queries, consider caching results

## Troubleshooting Common Issues

### Issue 1: Connection Problems
**Problem**: "Failed to connect to Ollama server"
**Solution**: Ensure Ollama is running and accessible:
```bash
# Start Ollama if not running
ollama serve

# Test connection
curl http://localhost:11434/api/tags
```

### Issue 2: API Key Errors  
**Problem**: Authentication failures with Kimi
**Solution**: Verify your API key is correct and has proper permissions

### Issue 3: Model Not Found
**Problem**: "Model not found" error
**Solution**: Pull the model with Ollama:
```bash
ollama pull llama3:latest
```

### Issue 4: Performance Issues
**Problem**: Slow response times
**Solution**: 
- Use appropriate models for your task (lightweight for simple tasks)
- Consider upgrading to a more powerful local system if needed
- Implement timeout handling in your applications

## Advanced Usage

### Provider-Specific Features
```typescript
// Ollama-specific optimizations
const ollamaOptions = {
  provider: 'ollama',
  model: 'llama3:latest',
  options: {
    // Ollama-specific parameters
    num_ctx: 4096, // Context length
    temperature: 0.7,
    top_k: 50,
    top_p: 0.9
  }
};

// Kimi-specific optimizations  
const kimiOptions = {
  provider: 'kimi',
  model: 'kimi',
  options: {
    // Kimi-specific parameters
    stream: true,
    presence_penalty: 0,
    frequency_penalty: 0
  }
};
```

## Environment Setup Script

Create a setup script (`setup-providers.bat`) to automate configuration:

```batch
@echo off
echo Setting up DeepSeek custom providers...

rem Check if Ollama is running
echo Checking Ollama connection...
curl -s http://localhost:11434/api/tags > nul
if %errorlevel% equ 0 (
    echo Ollama server is running
) else (
    echo Starting Ollama server...
    ollama serve &
)

rem Set environment variables for Kimi
set KIMI_API_KEY=your_kimi_key_here

echo Custom providers setup complete!
echo You can now use 'ollama' and 'kimi' providers in your DeepSeek agents.
```

This setup provides a comprehensive way to integrate local Ollama models with cloud-based Kimi AI, giving you the flexibility to choose the right provider for each task based on performance needs, complexity requirements, and resource availability.
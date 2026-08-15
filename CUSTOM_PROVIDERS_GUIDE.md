# Custom Providers for DeepSeek Harness

This guide shows how to add custom providers like Kimi and Ollama to the DeepSeek harness.

## Architecture Overview

The DeepSeek harness uses a provider-neutral LLM architecture where:
- Providers are registered via `ctx.llm.registerAdapter()`
- Each adapter handles specific provider routes (like "kimi", "ollama", "openai")
- Configuration is done through settings namespaces
- Model discovery and routing are handled automatically

## Adding New Providers

### Method 1: Create a Custom Provider Package

Create a new package in the `packages` directory:

```bash
mkdir C:\Users\Biyocon\Deepseek\packages\llm-ollama
mkdir C:\Users\Biyocon\Deepseek\packages\llm-kimi
```

### Method 2: Create Provider Adapter Files

For Ollama provider (`packages/llm-ollama/src/index.ts`):

```typescript
import { LlmAdapter, LlmCallConfig, StreamChunk } from '@deepseek-ai/dsh-llm';
import { ReadableStream } from 'stream/web';

export class OllamaLlmAdapter extends LlmAdapter {
  private readonly baseUrl: string;

  constructor(baseUrl: string = 'http://localhost:11434') {
    super();
    this.baseUrl = baseUrl;
  }

  async *stream(config: LlmCallConfig): AsyncGenerator<StreamChunk> {
    const response = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: config.model,
        prompt: this.extractPromptFromMessages(config.messages),
        stream: true,
        options: {
          temperature: config.temperature,
          max_tokens: config.maxTokens,
          stop: config.stop
        }
      })
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Failed to get response reader');
    }

    try {
      // Parse streaming responses
      const decoder = new TextDecoder();
      let buffer = '';
      
      while (true) {
        const { done, value } = await reader.read();
        
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        
        // Process complete JSON objects in the buffer
        while (true) {
          const newlineIndex = buffer.indexOf('\n');
          if (newlineIndex === -1) break;
          
          const line = buffer.substring(0, newlineIndex);
          buffer = buffer.substring(newlineIndex + 1);
          
          if (line.trim() === '') continue;
          
          try {
            const data = JSON.parse(line);
            
            // Handle different types of responses
            if (data.response) {
              yield { 
                type: 'text-delta', 
                text: data.response 
              };
            }
            
            if (data.done) {
              yield { 
                type: 'finish', 
                finish: { kind: 'success' } 
              };
            }
          } catch (e) {
            console.error('Error parsing Ollama response:', e);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  // Helper to extract prompt from messages
  private extractPromptFromMessages(messages: any[]): string {
    return messages.map(msg => msg.content).join('\n');
  }

  // Get provider info (optional)
  get providerInfo(): { id: string; name: string } {
    return { 
      id: 'ollama', 
      name: 'Ollama Local Models' 
    };
  }

  // List models (optional)
  async listModels(): Promise<any[]> {
    const response = await fetch(`${this.baseUrl}/api/tags`);
    if (!response.ok) {
      throw new Error('Failed to get Ollama models');
    }
    
    const data = await response.json();
    return data.models.map((model: any) => ({
      id: model.name,
      name: model.name,
      description: `Ollama model: ${model.name}`
    }));
  }

  // Resolve model information (optional)
  async resolveModelInfo(modelId: string): Promise<any> {
    // In a real implementation, this would check specific capabilities
    return {
      id: modelId,
      name: modelId,
      contextWindow: 2048,
      maxTokens: 4096
    };
  }

  async providerRetryPolicy(): Promise<ResolvableRetryPolicy> {
    return 'exponential';
  }
}
```

For Kimi Provider (`packages/llm-kimi/src/index.ts`):

```typescript
import { LlmAdapter, LlmCallConfig, StreamChunk } from '@deepseek-ai/dsh-llm';

export class KimiLlmAdapter extends LlmAdapter {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, baseUrl: string = 'https://api.kimi.ai') {
    super();
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  async *stream(config: LlmCallConfig): AsyncGenerator<StreamChunk> {
    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: config.model,
        messages: config.messages,
        stream: true,
        temperature: config.temperature,
        max_tokens: config.maxTokens,
        stop: config.stop
      })
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: 'Unknown error' }));
      throw new Error(`Kimi API error: ${error.message || response.statusText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Failed to get response reader');
    }

    try {
      const decoder = new TextDecoder();
      let buffer = '';
      
      while (true) {
        const { done, value } = await reader.read();
        
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        
        // Process streaming chunks
        while (true) {
          const newlineIndex = buffer.indexOf('\n');
          if (newlineIndex === -1) break;
          
          const line = buffer.substring(0, newlineIndex);
          buffer = buffer.substring(newlineIndex + 1);
          
          if (line.trim() === '' || !line.startsWith('data: ')) continue;
          
          try {
            const dataStr = line.substring(6); // Remove "data: " prefix
            if (dataStr === '[DONE]') {
              yield { 
                type: 'finish', 
                finish: { kind: 'success' } 
              };
              break;
            }
            
            const data = JSON.parse(dataStr);
            
            if (data.choices && data.choices[0]?.delta?.content) {
              yield { 
                type: 'text-delta', 
                text: data.choices[0].delta.content 
              };
            }
          } catch (e) {
            console.error('Error parsing Kimi response:', e);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async providerRetryPolicy(): Promise<ResolvableRetryPolicy> {
    return 'exponential';
  }
}
```

### Method 3: Register Providers in Your Application

Create a configuration script that registers these providers with the DeepSeek harness:

```typescript
// Register the providers in your agent or application
import { ctx } from '@deepseek-ai/dsh-core';
import { OllamaLlmAdapter } from './packages/llm-ollama/src/index';
import { KimiLlmAdapter } from './packages/llm-kimi/src/index';

// Register Ollama provider (for local models)
const ollamaAdapter = new OllamaLlmAdapter('http://localhost:11434');
ctx.llm.registerAdapter(['ollama'], ollamaAdapter);

// Register Kimi provider
const kimiAdapter = new KimiLlmAdapter(process.env.KIMI_API_KEY!);
ctx.llm.registerAdapter(['kimi'], kimiAdapter);

// You can also register multiple routes for the same adapter
// ctx.llm.registerAdapter(['ollama-local', 'local-ollama'], ollamaAdapter);
```

### Method 4: Configuration Files

Create configuration files to make it easy to use these providers:

**ollama-provider-config.json**
```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434",
      "defaultModel": "llama3:latest"
    }
  }
}
```

**kimi-provider-config.json**
```json
{
  "providers": {
    "kimi": {
      "apiKey": "your-kimi-api-key-here",
      "baseUrl": "https://api.kimi.ai",
      "defaultModel": "kimi"
    }
  }
}
```

## Usage in Agent Code

Once providers are registered, you can use them in your agents:

```typescript
// Using Ollama provider
const response = await ctx.llm.prepareCall({
  provider: 'ollama',
  model: 'llama3:latest',
  messages: [
    { role: 'user', content: 'Explain quantum computing' }
  ],
  temperature: 0.7,
  maxTokens: 1000
});

// Using Kimi provider  
const kimiResponse = await ctx.llm.prepareCall({
  provider: 'kimi',
  model: 'kimi',
  messages: [
    { role: 'user', content: 'What is the capital of France?' }
  ],
  temperature: 0.3,
  maxTokens: 200
});
```

## Adding to Your Existing Setup

1. **Create provider directories**:
   ```bash
   mkdir packages\llm-ollama
   mkdir packages\llm-kimi
   ```

2. **Add package.json files**:
   - For `packages/llm-ollama/package.json`
   - For `packages/llm-kimi/package.json`

3. **Run pnpm install** to make the packages available:
   ```bash
   cd C:\Users\Biyocon\Deepseek
   pnpm install
   ```

4. **Import and register providers** in your main application file

## Testing

To test if your custom providers are working:

1. Check registered providers:
   ```typescript
   const providers = ctx.llm.listProviders();
   console.log('Registered providers:', providers);
   ```

2. Test model discovery:
   ```typescript
   const models = await ctx.llm.listModels('ollama');
   console.log('Ollama models:', models);
   ```

## Troubleshooting

Common issues:
1. **Provider registration conflicts**: Make sure you're registering unique provider routes
2. **Network connectivity**: Ensure Ollama server or Kimi API is accessible
3. **API key issues**: Verify your keys are correct and have proper permissions
4. **TypeScript compilation**: Make sure your custom TypeScript adapts properly with the existing codebase

## Important Notes

- Providers need to be registered before they can be used
- All providers must inherit from `LlmAdapter` 
- The adapter should handle streaming correctly for asynchronous responses
- Configuration should be handled through settings namespaces to maintain flexibility
- Custom providers should integrate well with existing retry and error handling patterns in the harness
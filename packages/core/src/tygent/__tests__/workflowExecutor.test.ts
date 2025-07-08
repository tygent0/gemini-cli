import { describe, it, expect, vi } from 'vitest';
import { runPromptWithTools } from '../workflowExecutor.js';
import { BaseTool, ToolResult, ToolRegistry, Config } from '../../index.js';
import { GeminiClient } from '../../core/client.js';

class DummyTool extends BaseTool<Record<string, unknown>, ToolResult> {
  constructor() {
    super('dummy', 'dummy', 'dummy tool', {});
  }
  async execute() {
    return { returnDisplay: 'done', llmContent: { parts: [{ text: 'tool' }] } } as ToolResult;
  }
}

class MockClient {
  callCount = 0;
  generateContent = vi.fn(async () => {
    this.callCount++;
    if (this.callCount === 1) {
      return {
        candidates: [
          {
            content: { parts: [{ text: '' }] },
            functionCalls: [{ name: 'dummy', id: '1', args: {} }],
          },
        ],
      } as any;
    }
    return {
      candidates: [
        {
          content: { parts: [{ text: 'final' }] },
        },
      ],
    } as any;
  });
}

describe('TygentScheduler', () => {
  it('runs an llm call and tool via runPromptWithTools', async () => {
    const registry = new ToolRegistry({} as Config);
    registry.registerTool(new DummyTool());
    const client = new MockClient() as unknown as GeminiClient;
    const result = await runPromptWithTools(client, registry, 'prompt');
    expect(result).toBe('final');
    expect((client as any).generateContent).toHaveBeenCalledTimes(2);
  });
});

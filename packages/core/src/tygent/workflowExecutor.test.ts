import { describe, it, expect, vi } from 'vitest';
import { runPromptWithTools } from './workflowExecutor.js';
import type { GeminiClient } from '../core/client.js';
import type { ToolRegistry } from '../index.js';
import type { GenerateContentResponse } from '@google/genai';
import { FinishReason } from '@google/genai';


const mockResponse: GenerateContentResponse = {
  candidates: [
    {
      content: { parts: [{ text: 'hello' }], role: 'model' },
      finishReason: FinishReason.STOP,
      index: 0,
      safetyRatings: [],
    },
  ],
  promptFeedback: { safetyRatings: [] },
};

describe('runPromptWithTools', () => {
  it('performs only one LLM call when no tools are requested', async () => {
    const generateContent = vi.fn().mockResolvedValue(mockResponse);
    const client = { generateContent } as unknown as GeminiClient;
    const registry = {} as ToolRegistry;

    const result = await runPromptWithTools(client, registry, 'hello');

    expect(result).toBe('hello');
    expect(generateContent).toHaveBeenCalledTimes(1);
  });
});

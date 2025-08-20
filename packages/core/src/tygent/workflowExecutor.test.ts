/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { runPromptWithTools } from './workflowExecutor.js';
import type { GeminiClient } from '../core/client.js';
import type { ToolRegistry } from '../index.js';
import type { GenerateContentResponse } from '@google/genai';
import type { Config } from '../config/config.js';
import { FinishReason } from '@google/genai';


const mockResponse = {
  candidates: [
    {
      content: { parts: [{ text: 'hello' }], role: 'model' },
      finishReason: FinishReason.STOP,
      index: 0,
      safetyRatings: [],
    },
  ],
  promptFeedback: { safetyRatings: [] },
} as unknown as GenerateContentResponse;

describe('runPromptWithTools', () => {
  it('performs only one LLM call when no tools are requested', async () => {
    const generateContent = vi.fn().mockResolvedValue(mockResponse);
    const config = {
      getModel: () => 'fake-model',
      getSessionId: () => 'session',
      getUsageStatisticsEnabled: () => false,
      getTelemetryLogPromptsEnabled: () => false,
    } as unknown as Config;
    const client = {
      generateContent,
      getConfig: () => config,
    } as unknown as GeminiClient;
    const registry = {
      getFunctionDeclarations: () => [],
    } as unknown as ToolRegistry;

    const result = await runPromptWithTools(client, registry, 'hello');

    expect(result).toBe('hello');
    expect(generateContent).toHaveBeenCalledTimes(1);
  });
});

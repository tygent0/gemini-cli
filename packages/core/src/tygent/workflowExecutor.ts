/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { GeminiClient } from '../core/client.js';
import { ToolRegistry, ToolCallRequestInfo } from '../index.js';
import { TygentScheduler } from './tygentScheduler.js';
import {
  FunctionCall,
  GenerateContentResponse,
} from '@google/genai';
import { getResponseText, getFunctionCalls } from '../utils/generateContentResponseUtilities.js';

/**
 * Executes a single prompt using Tygent to orchestrate the LLM call and any
 * resulting tool calls. Tool executions are parallelized when possible.
 *
 * The returned string is the model's final response after all tools complete.
 */
export async function runPromptWithTools(
  client: GeminiClient,
  registry: ToolRegistry,
  prompt: string,
  _signal: AbortSignal = new AbortController().signal,
): Promise<string> {
  // First run the LLM call directly to discover tool invocations.
  const initialResp = await client.generateContent(
    [{ role: 'user', parts: [{ text: prompt }] }],
    {},
    _signal,
  );

  const functionCalls: FunctionCall[] = getFunctionCalls(initialResp) ?? [];
  // If no tools are required, return the initial response text immediately.
  if (functionCalls.length === 0) {
    return getResponseText(initialResp) ?? String(initialResp);
  }

  // Build a scheduler for the tool executions and follow up LLM call.
  const scheduler = new TygentScheduler(client, registry);
  const toolNodeNames: string[] = [];
  for (const fc of functionCalls) {
    const request: ToolCallRequestInfo = {
      callId: fc.id ?? `${fc.name}-${Date.now()}`,
      name: fc.name ?? 'unknown_tool',
      args: (fc.args ?? {}) as Record<string, unknown>,
      isClientInitiated: false,
    };
    const nodeName = scheduler.addToolCall(request);
    toolNodeNames.push(nodeName);
  }

  const finalNode = scheduler.addLLMCall('continue', toolNodeNames);

  const results = await scheduler.run();
  const finalResp = results[finalNode] as GenerateContentResponse;
  return getResponseText(finalResp) ?? String(finalResp);
}

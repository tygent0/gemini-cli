/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { GeminiClient } from '../core/client.js';
import { ToolRegistry, ToolCallRequestInfo } from '../index.js';
import { TygentScheduler } from './tygentScheduler.js';
import { FunctionCall, GenerateContentResponse } from '@google/genai';
import {
  getResponseText,
  getFunctionCalls,
} from '../utils/generateContentResponseUtilities.js';
import {
  logApiRequest,
  logApiResponse,
  logApiError,
} from '../telemetry/loggers.js';
import {
  ApiErrorEvent,
  ApiRequestEvent,
  ApiResponseEvent,
} from '../telemetry/types.js';

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
  const config = client.getConfig();
  // First run the LLM call directly to discover tool invocations.
  logApiRequest(config, new ApiRequestEvent(config.getModel(), prompt));
  const startTime = Date.now();
  let initialResp: GenerateContentResponse;
  try {
    initialResp = await client.generateContent(
      [{ role: 'user', parts: [{ text: prompt }] }],
      {},
      _signal,
    );
    const durationMs = Date.now() - startTime;
    logApiResponse(
      config,
      new ApiResponseEvent(
        config.getModel(),
        durationMs,
        initialResp.usageMetadata,
        getResponseText(initialResp),
      ),
    );
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const message = error instanceof Error ? error.message : String(error);
    const type = error instanceof Error ? error.name : 'unknown';
    logApiError(
      config,
      new ApiErrorEvent(config.getModel(), message, durationMs, type),
    );
    throw error;
  }

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

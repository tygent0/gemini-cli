/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { GeminiClient } from '../core/client.js';
import { ToolRegistry, ToolCallRequestInfo } from '../index.js';
import { TygentScheduler, ExecutionEvent } from './tygentScheduler.js';
import {
  FunctionCall,
  GenerateContentResponse,
  Content,
  Part,
} from '@google/genai';
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
import { executeToolCall } from '../core/nonInteractiveToolExecutor.js';

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
  events?: ExecutionEvent[],
): Promise<string> {
  const config = client.getConfig();
  // First run the LLM call directly to discover tool invocations.
  logApiRequest(config, new ApiRequestEvent(config.getModel(), prompt));
  const startTime = Date.now();
  let initialResp: GenerateContentResponse;
  try {
    initialResp = await client.generateContent(
      [{ role: 'user', parts: [{ text: prompt }] }],
      {
        tools: [{ functionDeclarations: registry.getFunctionDeclarations() }],
      },
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
  } finally {
    events?.push({
      type: 'llm',
      name: 'llm_plan',
      context: prompt,
      start: startTime,
      end: Date.now(),
    });
  }

  const functionCalls: FunctionCall[] = getFunctionCalls(initialResp) ?? [];
  // If no tools are required, return the initial response text immediately.
  if (functionCalls.length === 0) {
    return getResponseText(initialResp) ?? String(initialResp);
  }

  // Build a scheduler for the tool executions and follow up LLM call.
  const scheduler = new TygentScheduler(client, registry, events);
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

  const toolResults = await scheduler.run();
  const toolParts: Part[] = [];
  for (const nodeName of toolNodeNames) {
    const res = toolResults[nodeName] as { responseParts?: Part | Part[] };
    if (res?.responseParts) {
      const parts = Array.isArray(res.responseParts)
        ? res.responseParts
        : [res.responseParts];
      for (const part of parts) {
        if (typeof part === 'string') toolParts.push({ text: part });
        else if (part) toolParts.push(part);
      }
    }
  }

  const followContext = toolParts
    .map((p) => (p as Part).text ?? '')
    .join(' ')
    .slice(0, 100);
  const followStart = Date.now();
  logApiRequest(config, new ApiRequestEvent(config.getModel(), followContext));
  let finalResp: GenerateContentResponse;
  try {
    finalResp = await client.generateContent(
      [{ role: 'user', parts: toolParts }],
      {},
      _signal,
    );
    const durationMs = Date.now() - followStart;
    logApiResponse(
      config,
      new ApiResponseEvent(
        config.getModel(),
        durationMs,
        finalResp.usageMetadata,
        getResponseText(finalResp),
      ),
    );
  } catch (error) {
    const durationMs = Date.now() - followStart;
    const message = error instanceof Error ? error.message : String(error);
    const type = error instanceof Error ? error.name : 'unknown';
    logApiError(
      config,
      new ApiErrorEvent(config.getModel(), message, durationMs, type),
    );
    throw error;
  } finally {
    events?.push({
      type: 'llm',
      name: 'llm_0',
      context: followContext,
      start: followStart,
      end: Date.now(),
    });
  }

  return getResponseText(finalResp) ?? String(finalResp);
}

/**
 * Executes a prompt without using Tygent, running tool calls sequentially.
 * Records LLM and tool timing events when an events array is provided.
 */
export async function runPromptSequentially(
  client: GeminiClient,
  registry: ToolRegistry,
  prompt: string,
  signal: AbortSignal = new AbortController().signal,
  events?: ExecutionEvent[],
): Promise<string> {
  const chat = await client.getChat();
  let currentMessages: Content[] = [{ role: 'user', parts: [{ text: prompt }] }];
  let output = '';
  let llmCount = 0;

  while (true) {
    const functionCalls: FunctionCall[] = [];
    const llmName = `llm_${llmCount++}`;
    const llmStart = Date.now();
    const respStream = await chat.sendMessageStream({
      message: currentMessages[0].parts || [],
      config: {
        abortSignal: signal,
        tools: [{ functionDeclarations: registry.getFunctionDeclarations() }],
      },
    });
    for await (const resp of respStream) {
      if (signal.aborted) throw new Error('aborted');
      const text = getResponseText(resp);
      if (text) output += text;
      if (resp.functionCalls) functionCalls.push(...resp.functionCalls);
    }
    const llmEnd = Date.now();
    events?.push({
      type: 'llm',
      name: llmName,
      context: (currentMessages[0].parts ?? [])
        .map((p) => (p as Part).text ?? '')
        .join(' '),
      start: llmStart,
      end: llmEnd,
    });

    if (functionCalls.length === 0) {
      return output;
    }

    const toolParts: Part[] = [];
    for (const fc of functionCalls) {
      const request: ToolCallRequestInfo = {
        callId: fc.id ?? `${fc.name}-${Date.now()}`,
        name: fc.name ?? 'unknown_tool',
        args: (fc.args ?? {}) as Record<string, unknown>,
        isClientInitiated: false,
      };
      const toolStart = Date.now();
      const result = await executeToolCall(client.getConfig(), request, registry, signal);
      const toolEnd = Date.now();
      events?.push({
        type: 'tool',
        name: `tool_${fc.name}`,
        context: JSON.stringify(request.args),
        start: toolStart,
        end: toolEnd,
      });
      if (result.responseParts) {
        const parts = Array.isArray(result.responseParts)
          ? result.responseParts
          : [result.responseParts];
        for (const part of parts) {
          if (typeof part === 'string') toolParts.push({ text: part });
          else if (part) toolParts.push(part);
        }
      }
    }

    currentMessages = [{ role: 'user', parts: toolParts }];
  }
}

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
  signal: AbortSignal = new AbortController().signal,
): Promise<string> {
  const scheduler = new TygentScheduler(client, registry);
  const llmNode = scheduler.addLLMCall(prompt);

  // Run the initial LLM call to discover required tool invocations.
  const firstResults = (await scheduler.run())[llmNode] as GenerateContentResponse;
  const functionCalls: FunctionCall[] =
    getFunctionCalls(firstResults) ?? [];

  const toolNodeNames: string[] = [];
  for (const fc of functionCalls) {
    const request: ToolCallRequestInfo = {
      callId: fc.id ?? `${fc.name}-${Date.now()}`,
      name: fc.name ?? 'unknown_tool',
      args: (fc.args ?? {}) as Record<string, unknown>,
      isClientInitiated: false,
    };
    const nodeName = scheduler.addToolCall(request, [llmNode]);
    toolNodeNames.push(nodeName);
  }

  let finalNode = llmNode;
  if (toolNodeNames.length) {
    // Add a follow up LLM call that depends on all tools finishing.
    finalNode = scheduler.addLLMCall('continue', toolNodeNames);
  }

  const results = await scheduler.run();
  const finalResp = results[finalNode] as GenerateContentResponse;
  return getResponseText(finalResp) ?? String(finalResp);
}

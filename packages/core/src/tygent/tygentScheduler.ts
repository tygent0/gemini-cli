/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { DAG, LLMNode, ToolNode, Scheduler } from 'tygent';
import { GeminiClient } from '../core/client.js';
import { ToolRegistry, ToolCallRequestInfo, ToolResult } from '../index.js';
import {
  logApiRequest,
  logApiResponse,
  logApiError,
} from '../telemetry/loggers.js';
import {
  ApiRequestEvent,
  ApiResponseEvent,
  ApiErrorEvent,
} from '../telemetry/types.js';
import { getStructuredResponse } from '../utils/generateContentResponseUtilities.js';

export type TygentNodeResult = {
  name: string;
  output: unknown;
};

export interface ExecutionEvent {
  type: 'llm' | 'tool';
  name: string;
  context: string;
  start: number;
  end: number;
}

/**
 * Scheduler that builds a DAG of LLM calls and tool executions using
 * Tygent's optimizer. Each LLM call and tool execution becomes a node in
 * the DAG which can be executed in parallel when dependencies allow.
 */
export class TygentScheduler {
  private dag: DAG;
  private scheduler: Scheduler;
  private nodeCount = 0;

  constructor(
    private client: GeminiClient,
    private toolRegistry: ToolRegistry,
    private events?: ExecutionEvent[],
  ) {
    this.dag = new DAG('gemini_workflow');
    this.scheduler = new Scheduler(this.dag);
  }

  private recordEvent(event: ExecutionEvent) {
    this.events?.push(event);
  }

  /**
   * Add an LLM call to the DAG.
   * @param prompt The text prompt to send to the model.
   * @param dependsOn Optional dependency node names.
   * @returns The created node name.
   */
  addLLMCall(prompt: string, dependsOn: string[] = []): string {
    const name = `llm_${this.nodeCount++}`;
    const node = new LLMNode(name);
    node.setDependencies(dependsOn);
    node.execute = async () => {
      const config = this.client.getConfig();
      logApiRequest(config, new ApiRequestEvent(config.getModel(), prompt));
      const startTime = Date.now();
      try {
        const resp = await this.client.generateContent(
          [{ role: 'user', parts: [{ text: prompt }] }],
          {},
          AbortSignal.timeout(300000),
        );
        const durationMs = Date.now() - startTime;
        logApiResponse(
          config,
          new ApiResponseEvent(
            config.getModel(),
            durationMs,
            resp.usageMetadata,
            getStructuredResponse(resp),
          ),
        );
        return resp;
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
        this.recordEvent({
          type: 'llm',
          name,
          context: prompt,
          start: startTime,
          end: Date.now(),
        });
      }
    };
    this.dag.addNode(node);
    return name;
  }

  /**
   * Add a tool execution to the DAG.
   * @param request The tool call information.
   * @param dependsOn Optional dependency node names.
   * @returns The created node name.
   */
  addToolCall(request: ToolCallRequestInfo, dependsOn: string[] = []): string {
    const name = `tool_${request.callId}`;
    const tool = this.toolRegistry.getTool(request.name);
    if (!tool) {
      throw new Error(`Tool ${request.name} not found`);
    }
    const node = new ToolNode(name, async () => {
      const startTime = Date.now();
      try {
        const result: ToolResult = await tool.execute(
          request.args,
          AbortSignal.timeout(300000),
        );
        return result;
      } finally {
        this.recordEvent({
          type: 'tool',
          name,
          context: `${request.name} ${JSON.stringify(request.args)}`,
          start: startTime,
          end: Date.now(),
        });
      }
    });
    node.setDependencies(dependsOn);
    this.dag.addNode(node);
    return name;
  }

  /**
   * Execute the DAG in parallel and return all node results.
   */
  async run(
    initialInputs: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const results = await this.scheduler.executeParallel(initialInputs);
    return results as Record<string, unknown>;
  }
}

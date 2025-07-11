/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { DAG, LLMNode, ToolNode, Scheduler } from 'tygent';
import { GeminiClient } from '../core/client.js';
import { ToolRegistry, ToolCallRequestInfo, ToolResult } from '../index.js';

export type TygentNodeResult = {
  name: string;
  output: unknown;
};

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
  ) {
    this.dag = new DAG('gemini_workflow');
    this.scheduler = new Scheduler(this.dag);
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
      const resp = await this.client.generateContent(
        [{ role: 'user', parts: [{ text: prompt }] }],
        {},
        AbortSignal.timeout(300000),
      );
      return resp;
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
      const result: ToolResult = await tool.execute(
        request.args,
        AbortSignal.timeout(300000),
      );
      return result;
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

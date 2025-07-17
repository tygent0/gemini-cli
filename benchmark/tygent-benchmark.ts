/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'crypto';
import fs from 'node:fs';
import {
  Config,
  DEFAULT_GEMINI_MODEL,
  AuthType,
  runPromptWithTools,
  executeToolCall,
  uiTelemetryService,
  ToolRegistry,
  ToolCallRequestInfo,
} from '../packages/core/dist/src/index.js';
import { GeminiClient } from '../packages/core/dist/src/core/client.js';
import {
  Content,
  FunctionCall,
  Part,
  GenerateContentResponse,
} from '@google/genai';
import { SessionMetrics } from '../packages/core/dist/src/telemetry/uiTelemetry.js';

const outIndex = process.argv.indexOf('--out');
let outStream: fs.WriteStream | undefined;
if (outIndex !== -1) {
  const outPath = process.argv[outIndex + 1];
  if (!outPath) {
    console.error('Error: --out requires a file path');
    process.exit(1);
  }
  outStream = fs.createWriteStream(outPath, { flags: 'w' });
}

function log(message: string) {
  console.log(message);
  if (outStream) outStream.write(message + '\n');
}

function getResponseText(resp: GenerateContentResponse): string | null {
  if (resp.candidates && resp.candidates.length > 0) {
    const candidate = resp.candidates[0];
    if (candidate.content && candidate.content.parts && candidate.content.parts.length > 0) {
      const part0 = candidate.content.parts[0];
      if (part0?.thought) return null;
      return candidate.content.parts
        .filter((p: Part) => (p as Part).text)
        .map((p: Part) => (p as Part).text as string)
        .join('');
    }
  }
  return null;
}

async function runSequentialPrompt(
  client: GeminiClient,
  registry: ToolRegistry,
  prompt: string,
  signal: AbortSignal,
): Promise<string> {
  const chat = await client.getChat();
  let currentMessages: Content[] = [{ role: 'user', parts: [{ text: prompt }] }];
  let output = '';
  while (true) {
    const functionCalls: FunctionCall[] = [];
    const respStream = await chat.sendMessageStream({
      message: currentMessages[0].parts || [],
      config: { abortSignal: signal, tools: [{ functionDeclarations: registry.getFunctionDeclarations() }] },
    });
    for await (const resp of respStream) {
      if (signal.aborted) throw new Error('aborted');
      const text = getResponseText(resp);
      if (text) output += text;
      if (resp.functionCalls) functionCalls.push(...resp.functionCalls);
    }
    if (functionCalls.length === 0) {
      return output;
    }
    const toolParts: Part[] = [];
    for (const fc of functionCalls) {
      const req: ToolCallRequestInfo = {
        callId: fc.id ?? `${fc.name}-${Date.now()}`,
        name: fc.name!,
        args: (fc.args ?? {}) as Record<string, unknown>,
        isClientInitiated: false,
      };
      const result = await executeToolCall(client.getConfig(), req, registry, signal);
      if (result.responseParts) {
        const parts = Array.isArray(result.responseParts) ? result.responseParts : [result.responseParts];
        for (const part of parts) {
          if (typeof part === 'string') toolParts.push({ text: part });
          else if (part) toolParts.push(part);
        }
      }
    }
    currentMessages = [{ role: 'user', parts: toolParts }];
  }
}

function cloneMetrics<T>(m: T): T {
  return JSON.parse(JSON.stringify(m)) as T;
}

function diffMetrics(before: SessionMetrics, after: SessionMetrics) {
  const sumTokens = (metrics: SessionMetrics) => {
    return Object.values(metrics.models).reduce((acc, mod) => acc + mod.tokens.total, 0);
  };
  return sumTokens(after) - sumTokens(before);
}

async function createConfig(useTygent: boolean): Promise<Config> {
  const cfg = new Config({
    sessionId: randomUUID(),
    targetDir: process.cwd(),
    debugMode: false,
    cwd: process.cwd(),
    model: DEFAULT_GEMINI_MODEL,
    useTygent,
    telemetry: { enabled: true },
  });
  await cfg.refreshAuth(AuthType.USE_GEMINI);
  return cfg;
}

async function runBenchmark() {
  const tasks = [
    { name: 'simple', prompt: 'What is the capital of France?' },
    { name: 'medium', prompt: 'Summarize the contents of README.md in two sentences.' },
    { name: 'complex', prompt: 'Write a short poem about concurrency in JavaScript.' },
  ];

  for (const useTygent of [false, true]) {
    log(`\nRunning with${useTygent ? '' : 'out'} Tygent`);
    for (const task of tasks) {
      const config = await createConfig(useTygent);
      const client = config.getGeminiClient();
      const registry = await config.getToolRegistry();
      const metricsBefore = cloneMetrics(uiTelemetryService.getMetrics());
      const start = Date.now();
      const text = useTygent
        ? await runPromptWithTools(client, registry, task.prompt)
        : await runSequentialPrompt(client, registry, task.prompt, new AbortController().signal);
      const duration = Date.now() - start;
      const metricsAfter = uiTelemetryService.getMetrics();
      const tokens = diffMetrics(metricsBefore, metricsAfter);
      log(`Task ${task.name}: ${duration}ms, ${tokens} tokens`);
      if (text) log(text.slice(0, 60).replace(/\n/g, ' '));
    }
  }
}

runBenchmark()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    if (outStream) outStream.end();
  });

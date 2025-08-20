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
  runPromptSequentially,
  uiTelemetryService,
  ToolRegistry,
  ExecutionEvent,
} from '../packages/core/dist/index.js';
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


function cloneMetrics<T>(m: T): T {
  return JSON.parse(JSON.stringify(m)) as T;
}

function diffMetrics(before: SessionMetrics, after: SessionMetrics) {
  const sumTokens = (metrics: SessionMetrics) => {
    return Object.values(metrics.models).reduce((acc, mod) => acc + mod.tokens.total, 0);
  };
  return sumTokens(after) - sumTokens(before);
}

function visualizeTimeline(events: ExecutionEvent[]) {
  if (events.length === 0) return;
  const start = Math.min(...events.map((e) => e.start));
  const end = Math.max(...events.map((e) => e.end));
  const total = end - start || 1;
  log('Timeline:');
  for (const e of events.sort((a, b) => a.start - b.start)) {
    const offset = e.start - start;
    const duration = e.end - e.start;
    const barStart = Math.round((offset / total) * 40);
    const barLen = Math.max(1, Math.round((duration / total) * 40));
    const bar = ' '.repeat(barStart) + '#'.repeat(barLen);
    log(
      `${e.type.toUpperCase()} ${e.name.padEnd(12)} | ${bar} | ${offset}ms -> ${offset + duration}ms ${e.context}`,
    );
  }
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
    { name: 'code-basic', prompt: 'Write a Python function that returns the sum of two numbers.' },
    { name: 'code-intermediate', prompt: 'Implement a recursive factorial function in JavaScript.' },
    { name: 'code-advanced', prompt: 'Create a Node.js HTTP server that responds with "Hello, world!".' },
    { name: 'code-doc', prompt: 'Write a JSDoc comment for a JavaScript function named multiply that returns the product of two numbers.' },
    { name: 'code-tests', prompt: 'Create a Jest test for a function isPalindrome that checks if a string is a palindrome.' },
    { name: 'code-debug', prompt: 'Fix the bug in this Python code: def add(a, b): return a - b' },
  ];

  for (const useTygent of [false, true]) {
    log(`\nRunning with${useTygent ? '' : 'out'} Tygent`);
    for (const task of tasks) {
      const config = await createConfig(useTygent);
      const client = config.getGeminiClient();
      const registry: ToolRegistry = await config.getToolRegistry();
      const metricsBefore = cloneMetrics(uiTelemetryService.getMetrics());
      const start = Date.now();
      const events: ExecutionEvent[] = [];
      const text = useTygent
        ? await runPromptWithTools(client, registry, task.prompt, new AbortController().signal, events)
        : await runPromptSequentially(client, registry, task.prompt, new AbortController().signal, events);
      const duration = Date.now() - start;
      const metricsAfter = uiTelemetryService.getMetrics();
      const tokens = diffMetrics(metricsBefore, metricsAfter);
      log(`Task ${task.name}: ${duration}ms, ${tokens} tokens`);
      if (text) log(text.slice(0, 60).replace(/\n/g, ' '));
      visualizeTimeline(events);
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

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'crypto';
import fs from 'node:fs';
import https from 'node:https';
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

interface RepoSource {
  owner: string;
  repo: string;
  branch: string;
  file: string;
  task: string;
}

const repoSources: RepoSource[] = [
  {
    owner: 'facebook',
    repo: 'react',
    branch: 'main',
    file: 'README.md',
    task: 'Refactor the hooks implementation to support concurrent mode.',
  },
  {
    owner: 'microsoft',
    repo: 'vscode',
    branch: 'main',
    file: 'README.md',
    task: 'Improve extension activation to reduce startup time.',
  },
  {
    owner: 'tensorflow',
    repo: 'tensorflow',
    branch: 'master',
    file: 'README.md',
    task: 'Add support for a new hardware accelerator in the training pipeline.',
  },
];

let repoSnippets: string[] = [];

async function fetchText(url: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`Request failed with status ${res.statusCode}`));
          res.resume();
          return;
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => resolve(data));
      })
      .on('error', reject);
  });
}

async function loadRepoSnippets() {
  const snippets = await Promise.all(
    repoSources.map(async (src) => {
      try {
        const url = `https://raw.githubusercontent.com/${src.owner}/${src.repo}/${src.branch}/${src.file}`;
        const content = await fetchText(url);
        return `Repository: ${src.owner}/${src.repo}\nTask: ${src.task}\n\n${content}`;
      } catch (err) {
        log(`Failed to fetch ${src.owner}/${src.repo}: ${String(err)}`);
        return '';
      }
    })
  );
  repoSnippets = snippets.filter((s) => s.length > 0);
  if (repoSnippets.length === 0) {
    repoSnippets = ['Repository: example/example\nTask: Explore the codebase and write tests.'];
  }
}

function buildPrompt(bytes: number): string {
  const header = 'Respond with a short acknowledgement.\n\n';
  const pieces = [header];
  let i = 0;
  while (pieces.join('').length < bytes) {
    pieces.push(repoSnippets[i % repoSnippets.length] + '\n');
    i++;
  }
  let prompt = pieces.join('');
  if (prompt.length > bytes) {
    prompt = prompt.slice(0, bytes);
  }
  return prompt;
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
  await loadRepoSnippets();
  const sizes = [
    { name: '4KB', bytes: 4 * 1024 },
    { name: '40KB', bytes: 40 * 1024 },
    { name: '400KB', bytes: 400 * 1024 },
    { name: '4MB', bytes: 4 * 1024 * 1024 },
  ];

  for (const useTygent of [false, true]) {
    log(`\nRunning with${useTygent ? '' : 'out'} Tygent`);
    for (const size of sizes) {
      const prompt = buildPrompt(size.bytes);
      log(`Prompt size ${size.name} (${prompt.length} bytes)`);
      const config = await createConfig(useTygent);
      const client = config.getGeminiClient();
      const registry: ToolRegistry = await config.getToolRegistry();
      const metricsBefore = cloneMetrics(uiTelemetryService.getMetrics());
      const start = Date.now();
      const events: ExecutionEvent[] = [];
      try {
        const text = useTygent
          ? await runPromptWithTools(client, registry, prompt, new AbortController().signal, events)
          : await runPromptSequentially(client, registry, prompt, new AbortController().signal, events);
        const duration = Date.now() - start;
        const metricsAfter = uiTelemetryService.getMetrics();
        const tokens = diffMetrics(metricsBefore, metricsAfter);
        log(`Size ${size.name}: ${duration}ms, ${tokens} tokens`);
        if (text) log(text.slice(0, 60).replace(/\n/g, ' '));
      } catch (err: unknown) {
        const duration = Date.now() - start;
        log(`Size ${size.name}: error after ${duration}ms`);
        log(String(err));
      }
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

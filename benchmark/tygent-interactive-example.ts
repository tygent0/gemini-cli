import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { randomUUID } from 'crypto';
import {
  Config,
  DEFAULT_GEMINI_MODEL,
  AuthType,
  runPromptWithTools,
  executeToolCall,
  uiTelemetryService,
  ToolRegistry,
  ToolCallRequestInfo,
} from '../packages/core/dist/index.js';
import { GeminiClient } from '../packages/core/dist/src/core/client.js';
import {
  Content,
  FunctionCall,
  Part,
  GenerateContentResponse,
} from '@google/genai';

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

function diffMetrics(before: any, after: any) {
  const sumTokens = (metrics: any) => {
    return Object.values(metrics.models).reduce((acc: number, mod: any) => acc + mod.tokens.total, 0);
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

async function run(prompt: string) {
  for (const useTygent of [false, true]) {
    const config = await createConfig(useTygent);
    const client = config.getGeminiClient();
    const registry = await config.getToolRegistry();
    const metricsBefore = cloneMetrics(uiTelemetryService.getMetrics());
    const start = Date.now();
    const text = useTygent
      ? await runPromptWithTools(client, registry, prompt)
      : await runSequentialPrompt(client, registry, prompt, new AbortController().signal);
    const duration = Date.now() - start;
    const metricsAfter = uiTelemetryService.getMetrics();
    const tokens = diffMetrics(metricsBefore, metricsAfter);
    console.log(`\n${useTygent ? 'With' : 'Without'} Tygent:`);
    console.log(`  Latency: ${duration}ms`);
    console.log(`  Tokens: ${tokens}`);
    if (text) console.log(`  Output: ${text.replace(/\n/g, ' ').slice(0, 80)}`);
  }
}

async function main() {
  const rl = readline.createInterface({ input, output });
  const prompt = await rl.question('Enter prompt: ');
  rl.close();
  await run(prompt);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

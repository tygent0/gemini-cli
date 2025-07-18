import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { randomUUID } from 'crypto';
import {
  Config,
  DEFAULT_GEMINI_MODEL,
  AuthType,
  uiTelemetryService,
} from '../packages/core/dist/index.js';
import { runNonInteractive } from '../packages/cli/dist/src/nonInteractiveCli.js';

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
    const metricsBefore = cloneMetrics(uiTelemetryService.getMetrics());
    const start = Date.now();
    await runNonInteractive(config, prompt);
    const duration = Date.now() - start;
    const metricsAfter = uiTelemetryService.getMetrics();
    const tokens = diffMetrics(metricsBefore, metricsAfter);
    console.log(`\n${useTygent ? 'With' : 'Without'} Tygent:`);
    console.log(`  Latency: ${duration}ms`);
    console.log(`  Tokens: ${tokens}`);
  }
}

async function main() {
  const rl = readline.createInterface({ input, output });
  console.log('Type a prompt to compare sequential execution with Tygent.');
  console.log('Use /clear to clear the screen or /exit to quit.');
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const prompt = await rl.question('Enter prompt: ');
    const trimmed = prompt.trim().toLowerCase();
    if (trimmed === '/exit') break;
    if (trimmed === '/clear') {
      console.clear();
      continue;
    }
    if (prompt) await run(prompt);
  }
  rl.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

# Tygent Integration Overview

This document describes the initial integration points for using the
[Tygent](https://github.com/tygent0/tygent-js) scheduler inside the
Gemini CLI.

## Integration Points

- **LLM Calls** – The `GeminiClient` class issues model requests via
  `generateContent` and `sendMessageStream`. These calls are now
  encapsulated in `TygentScheduler` as `LLMNode` instances so they can be
  scheduled alongside tool executions.
- **Tool Execution** – Tool invocations are performed by
  `CoreToolScheduler`. The new `TygentScheduler` exposes an `addToolCall`
  helper that wraps a tool from the `ToolRegistry` in a `ToolNode` for
  inclusion in the DAG.

`TygentScheduler` builds a DAG containing both LLM and tool nodes.
Independent nodes are executed in parallel using Tygent's `Scheduler`.

## Usage

```ts
import { TygentScheduler } from '@google/gemini-cli-core';

const scheduler = new TygentScheduler(client, toolRegistry);
const llm1 = scheduler.addLLMCall('Explain the repo');
const tool = scheduler.addToolCall(toolRequest, [llm1]);
const llm2 = scheduler.addLLMCall('Summarize', [tool]);

const results = await scheduler.run();
```

For convenience the core package now exposes a `runPromptWithTools` helper which
automates the above flow for a single prompt:

```ts
import { runPromptWithTools } from '@google/gemini-cli-core';

const reply = await runPromptWithTools(client, toolRegistry, 'Generate README');
```

This enables future work to delegate complex workflows to a single
parallel DAG while retaining the existing sequential logic as the
fallback.

## CLI Usage

You can enable the Tygent scheduler at runtime with the `--tygent` flag.
This works in both interactive and non-interactive modes:

```
gemini --tygent
echo "Generate README" | gemini --tygent
```

When enabled, tool calls requested by Gemini are executed in parallel
using the optimized DAG.

## Benchmark

A simple benchmark script is provided to compare latency and token
consumption with and without Tygent. Build the packages first and then
run the script using `ts-node`:

```bash
npm run build
node --loader ts-node/esm benchmark/tygent-benchmark.ts [--out results.txt]
```

Ensure you are authenticated before running the benchmark. You can either log in
with your Google account or provide a `GEMINI_API_KEY`. To use an API key,
generate one from [Google AI Studio](https://aistudio.google.com/app/apikey) and
export it:

```bash
export GEMINI_API_KEY="YOUR_API_KEY"
```

See [tygent-benchmark.md](./tygent-benchmark.md) for more details on running
the benchmark. For a quick interactive comparison you can run:

```bash
node --loader ts-node/esm benchmark/tygent-interactive-example.ts
```

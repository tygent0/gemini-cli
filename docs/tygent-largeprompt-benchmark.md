# Tygent Large Prompt Benchmark

This benchmark measures how Tygent handles very large prompt inputs. The
prompts are assembled from tasks and code snippets pulled from popular GitHub
repositories like React, VS Code, and TensorFlow. Four prompt sizes ranging from
4KB to 4MB are executed twice: once with the default sequential execution and
once using the Tygent scheduler.

## Prerequisites

- Node.js 18 or later
- Authentication configured (log in with Google or provide `GEMINI_API_KEY`)

## Steps

1. **Install dependencies**
   ```bash
   npm ci
   ```
2. **Build the packages**
   ```bash
   npm run build
   ```
3. **Run the benchmark**
   ```bash
   node --loader ts-node/esm benchmark/tygent-largeprompt-benchmark.ts [--out results.txt]
   ```
   The optional `--out` flag writes the output to a file in addition to the console.

The script prints the latency and token usage for each prompt size, allowing you
 to compare performance with and without Tygent.

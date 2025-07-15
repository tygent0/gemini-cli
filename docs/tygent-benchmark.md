# Tygent Benchmark

This document explains how the Tygent integration is tested for performance.

The benchmark compares the default sequential execution with the optional
Tygent scheduler that executes tools in parallel.

## Prerequisites

- Node.js 18 or later
- (Optional) `GEMINI_API_KEY` for higher request limits

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
   node --loader ts-node/esm benchmark/tygent-benchmark.ts
   ```

The script will run a set of sample prompts twice – once with Tygent disabled and
once with Tygent enabled – printing the latency and token usage for each.

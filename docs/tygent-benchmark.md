# Tygent Benchmark

This document explains how the Tygent integration is tested for performance.

The benchmark compares the default sequential execution with the optional
Tygent scheduler that executes tools in parallel.

## Prerequisites

- Node.js 18 or later
- Authentication configured. You can either log in with your Google account or
   provide a `GEMINI_API_KEY`:
   - **Login with Google:** run `gemini` and follow the browser prompt. The
     credentials are cached locally for reuse.
   - **API key:** generate one from
     [Google AI Studio](https://aistudio.google.com/app/apikey) and export it
     before running the benchmark:

     ```bash
     export GEMINI_API_KEY="YOUR_API_KEY"
     ```

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

If the script fails with an error such as `Could not load the default
credentials`, it means no credentials were found. Either log in with Google or
export a `GEMINI_API_KEY` before running.

The script will run a set of sample prompts twice – once with Tygent disabled and
once with Tygent enabled – printing the latency and token usage for each.

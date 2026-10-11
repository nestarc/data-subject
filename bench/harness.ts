import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

export interface BenchOptions {
  iterations: number;
  warmup: number;
  rows: number;
  batchSize: number;
}
export interface BenchCase {
  run(): Promise<void>;
  verify(): Promise<void> | void;
}
export interface Scenario {
  label: string;
  rows?: number;
  prepare(): BenchCase | Promise<BenchCase>;
}

export const USAGE = `Usage: npm run bench -- [--iterations 100] [--warmup 10] [--rows 1000] [--batch-size 128]
  --rows is the exact total target row count for each data scenario.
  --iterations/--rows: positive integers; --warmup: nonnegative integer.
  --batch-size: integer from 1 to 1000 (P2 handler scenarios only).`;

export function parseOptions(args: string[]): BenchOptions {
  const result: BenchOptions = { iterations: 100, warmup: 10, rows: 1000, batchSize: 128 };
  const names = { '--iterations': 'iterations', '--warmup': 'warmup', '--rows': 'rows', '--batch-size': 'batchSize' } as const;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    if (!Object.hasOwn(names, flag) || seen.has(flag)) throw new Error(`Unknown or duplicate option: ${flag}`);
    const key = names[flag as keyof typeof names];
    const value = args[i + 1];
    if (value === undefined || !/^\d+$/.test(value)) throw new Error(`${flag} requires an integer`);
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < (key === 'warmup' ? 0 : 1) || (key === 'batchSize' && number > 1000)) {
      throw new Error(`Invalid value for ${flag}: ${value}`);
    }
    result[key] = number;
    seen.add(flag);
  }
  return result;
}

export function computeStats(samples: number[]) {
  assert(samples.length > 0 && samples.every(value => Number.isFinite(value) && value >= 0));
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
  return {
    avg: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99),
  };
}

function formatTime(ms: number): string {
  return ms < 1 ? `${(ms * 1000).toFixed(1)}µs` : `${ms.toFixed(2)}ms`;
}

export async function measure(scenario: Scenario, options: BenchOptions): Promise<void> {
  const samples: number[] = [];
  for (let i = -options.warmup; i < options.iterations; i++) {
    const fixture = await scenario.prepare();
    const started = performance.now();
    await fixture.run();
    const elapsed = performance.now() - started;
    // Correctness checks and fixture construction are outside the timed interval.
    await fixture.verify();
    if (i >= 0) samples.push(elapsed);
  }
  const stats = computeStats(samples);
  console.log(`  ${scenario.label}`);
  console.log(`    avg ${formatTime(stats.avg)}  p50 ${formatTime(stats.p50)}  p95 ${formatTime(stats.p95)}  p99 ${formatTime(stats.p99)}`);
  if (scenario.rows !== undefined) {
    console.log(`    ${scenario.rows} target rows; ${stats.avg > 0 ? Math.round(1000 * scenario.rows / stats.avg).toLocaleString('en-US') : 'n/a'} rows/sec`);
  }
}

import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { Settings } from './contracts.js';
import { command, type Command } from './io.js';
import { drain } from './workflow.js';

const Options = z.object({
  maxCycles: z.number().int().min(1).max(60),
  maxEvents: z.number().int().min(1).max(20),
  intervalSeconds: z.number().int().min(1).max(3600).default(60),
  limit: z.number().int().min(1).max(20).default(1),
}).strict();
export type WatchOptions = z.input<typeof Options>;
type Batch = Awaited<ReturnType<typeof drain>>;
export type Cycle = { cycle: number; processed: number; remainingEvents: number; results: Batch };

// Explicit foreground runner. Limits bound polling and event attempts, not token cost.
export async function watch(c: Settings, options: WatchOptions, runtime: {
  exec?: Command; signal?: AbortSignal; onCycle?: (cycle: Cycle) => void | Promise<void>;
} = {}) {
  const o = Options.parse(options);
  let cycles = 0, processed = 0;
  const stopped = () => runtime.signal?.aborted || process.exitCode === 130 || process.exitCode === 143;
  const done = (reason: 'stopped' | 'failed' | 'event_limit' | 'cycle_limit') => ({ reason, cycles, processed });
  while (cycles < o.maxCycles && processed < o.maxEvents) {
    if (stopped()) return done('stopped');
    const results = await drain(c, Math.min(o.limit, o.maxEvents - processed), runtime.exec ?? command, runtime.signal);
    cycles++; processed += results.length;
    await runtime.onCycle?.({ cycle: cycles, processed, remainingEvents: o.maxEvents - processed, results });
    if (stopped()) return done('stopped');
    if (results.some(r => r.state === 'failed')) return done('failed');
    if (processed >= o.maxEvents) return done('event_limit');
    if (cycles >= o.maxCycles) return done('cycle_limit');
    try { await delay(o.intervalSeconds * 1000, undefined, { signal: runtime.signal }); }
    catch (error) { if (runtime.signal?.aborted) return done('stopped'); throw error; }
  }
  return done('cycle_limit');
}

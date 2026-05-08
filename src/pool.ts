import type { BrowserContext } from "playwright";
import { type DriverOptions, runJob } from "./runway.js";
import type { ResolvedJob } from "./types.js";

export interface PoolResult {
  job: ResolvedJob;
  ok: boolean;
  output?: string;
  sessionUrl?: string;
  error?: string;
}

export async function runPool(
  context: BrowserContext,
  jobs: ResolvedJob[],
  concurrency: number,
  options: DriverOptions,
  log: (msg: string) => void
): Promise<PoolResult[]> {
  const queue = [...jobs];
  const results: PoolResult[] = [];

  const worker = async (workerIndex: number): Promise<void> => {
    const tag = `[worker ${workerIndex + 1}]`;
    while (queue.length > 0) {
      const job = queue.shift();
      if (!job) {
        return;
      }
      const page = await context.newPage();
      try {
        log(`${tag} picked job ${job.name} (${queue.length} remaining)`);
        const { output, sessionUrl } = await runJob(page, job, options, log);
        results.push({ job, ok: true, output, sessionUrl });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`${tag} job ${job.name} failed: ${message}`);
        results.push({ job, ok: false, error: message, sessionUrl: page.url() });
      } finally {
        await page.close().catch(() => undefined);
      }
    }
  };

  const workerCount = Math.max(1, Math.min(concurrency, jobs.length));
  await Promise.all(Array.from({ length: workerCount }, (_, i) => worker(i)));
  return results;
}

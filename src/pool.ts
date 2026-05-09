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

  const submitGapMs = 30 * 1000;
  let earliestSlotMs = 0;
  const acquireSubmissionSlot = async (tag: string): Promise<void> => {
    const wait = Math.max(0, earliestSlotMs - Date.now());
    if (wait > 0) {
      log(`${tag} waiting ${Math.round(wait / 1000)}s for next submission slot`);
      await new Promise<void>((resolve) => setTimeout(resolve, wait));
    }
    earliestSlotMs = Date.now() + submitGapMs;
  };

  const worker = async (workerIndex: number): Promise<void> => {
    const tag = `[worker ${workerIndex + 1}]`;
    while (queue.length > 0) {
      const job = queue.shift();
      if (!job) {
        return;
      }
      log(`${tag} picked job ${job.name} (${queue.length} remaining)`);

      const maxAttempts = 2;
      let pushed = false;
      let lastError: string | undefined;
      let lastSessionUrl: string | undefined;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        await acquireSubmissionSlot(tag);
        const page = await context.newPage();
        try {
          if (attempt > 1) {
            log(`${tag} retry attempt ${attempt} for ${job.name}`);
          }
          const { output, sessionUrl } = await runJob(page, job, options, log);
          results.push({ job, ok: true, output, sessionUrl });
          pushed = true;
          break;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          lastSessionUrl = page.url();
          log(`${tag} job ${job.name} attempt ${attempt} failed: ${lastError}`);
        } finally {
          await page.close().catch(() => undefined);
        }
      }
      if (!pushed) {
        results.push({ job, ok: false, error: lastError, sessionUrl: lastSessionUrl });
      }
    }
  };

  const workerCount = Math.max(1, Math.min(concurrency, jobs.length));
  await Promise.all(Array.from({ length: workerCount }, (_, i) => worker(i)));
  return results;
}

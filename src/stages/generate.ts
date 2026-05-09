import { existsSync } from "node:fs";
import { join } from "node:path";
import { launchContext } from "../runway.js";
import { runPool } from "../pool.js";
import { projectDir, saveManifest, setStageStatus } from "../manifest.js";
import type { Manifest, ResolvedJob, ResolvedRef } from "../types.js";

export interface GenerateOptions {
  cwd?: string;
  log: (msg: string) => void;
  profileDir: string;
  generationUrl: string;
  generationTimeoutMs: number;
  upscaleTimeoutMs: number;
  pollIntervalMs: number;
  concurrency: number;
}

export async function runGenerate(manifest: Manifest, options: GenerateOptions): Promise<Manifest> {
  const cwd = options.cwd ?? process.cwd();
  setStageStatus(manifest, "generate", "running");
  saveManifest(manifest, cwd);

  const segmentsDir = join(projectDir(manifest.slug, cwd), "segments");
  const debugDir = join(projectDir(manifest.slug, cwd), "debug-out");

  const refLookup = new Map<string, string>();
  for (const c of manifest.characters) {
    if (c.imagePath) refLookup.set(c.name, c.imagePath);
  }
  for (const s of manifest.settings) {
    if (s.imagePath) refLookup.set(s.name, s.imagePath);
  }
  for (const p of manifest.props) {
    if (p.imagePath) refLookup.set(p.name, p.imagePath);
  }

  const pending: ResolvedJob[] = [];
  for (let i = 0; i < manifest.segments.length; i++) {
    const segment = manifest.segments[i];
    const target = join(segmentsDir, `${segment.name}.mp4`);
    if (segment.videoStatus === "done" && segment.videoPath && existsSync(segment.videoPath)) {
      options.log(`[generate] ${segment.name}: already done, skipping`);
      continue;
    }
    // Build refs as {name, path} pairs. The `name` becomes the upload
    // filename (`<name>.png`) so `@<name>` inside the segment prompt binds
    // to the right reference. Skip refs whose artifact didn't generate.
    const refs: ResolvedRef[] = [];
    for (const name of segment.refs) {
      const path = refLookup.get(name);
      if (path) refs.push({ name, path });
    }
    if (segment.firstFrameImagePath && existsSync(segment.firstFrameImagePath)) {
      refs.push({ name: "first-frame", path: segment.firstFrameImagePath });
    }
    pending.push({
      index: i,
      name: segment.name,
      prompt: segment.prompt,
      refs,
      model: segment.model,
      aspect: segment.aspect,
      duration: segment.duration,
      resolution: segment.resolution,
      upscale: segment.upscale,
      outputDir: segmentsDir
    });
  }

  if (pending.length === 0) {
    options.log("[generate] all segments already done");
    setStageStatus(manifest, "generate", "done");
    saveManifest(manifest, cwd);
    return manifest;
  }

  options.log(`[generate] launching browser; ${pending.length} segment(s); concurrency=${Math.min(options.concurrency, pending.length)}`);
  const context = await launchContext(options.profileDir);
  try {
    // Warm the persistent context. Empirically, the FIRST tab opened on a
    // freshly-launched persistent context can't reliably submit a Generate
    // click — Runway's React doesn't fully hydrate before the click goes out.
    // Open a throwaway page, navigate, wait, close — so subsequent tabs find
    // a "warm" context.
    options.log("[generate] warming browser context (~45s) so first worker isn't cold");
    const warmup = context.pages()[0] ?? await context.newPage();
    await warmup.goto(options.generationUrl, { waitUntil: "domcontentloaded" }).catch(() => undefined);
    await warmup.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => undefined);
    await warmup.waitForTimeout(15000);
    if (context.pages().length > 1) {
      await warmup.close().catch(() => undefined);
    }

    const results = await runPool(context, pending, options.concurrency, {
      generationUrl: options.generationUrl,
      generationTimeoutMs: options.generationTimeoutMs,
      upscaleTimeoutMs: options.upscaleTimeoutMs,
      pollIntervalMs: options.pollIntervalMs,
      debugDir
    }, options.log);

    for (const result of results) {
      const segment = manifest.segments.find((s) => s.name === result.job.name);
      if (!segment) continue;
      if (result.ok && result.output) {
        segment.videoPath = result.output;
        segment.videoStatus = "done";
        segment.videoError = undefined;
      } else {
        segment.videoStatus = "failed";
        segment.videoError = result.error;
      }
    }
    saveManifest(manifest, cwd);

    const failed = results.filter((r) => !r.ok);
    if (failed.length > 0) {
      setStageStatus(manifest, "generate", "failed", `${failed.length}/${results.length} segment(s) failed`);
      saveManifest(manifest, cwd);
      throw new Error(`${failed.length}/${results.length} segment(s) failed; rerun the generate stage to retry`);
    }
  } finally {
    await context.close().catch(() => undefined);
  }

  setStageStatus(manifest, "generate", "done");
  saveManifest(manifest, cwd);
  return manifest;
}

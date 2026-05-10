#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ensureProjectDirs, createManifest, listProjects, loadManifest, manifestPath, saveManifest, slugify, uniqueSlug } from "./manifest.js";
import { runIdeate } from "./stages/ideate.js";
import { runArtifacts } from "./stages/artifacts.js";
import { runFrames } from "./stages/frames.js";
import { runGenerate } from "./stages/generate.js";
import { runStitch } from "./stages/stitch.js";
import { runPolish } from "./stages/polish.js";
import { launchContext, waitForLogin } from "./runway.js";
import { STAGE_ORDER, type Manifest, type StageName } from "./types.js";

const DEFAULT_CODEX_MODEL = "gpt-5.5";
const DEFAULT_PROFILE_DIR = "runway-profile";
const DEFAULT_GEN_URL = "https://app.runwayml.com/";
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_GEN_TIMEOUT = 60 * 60 * 1000;
const DEFAULT_UPSCALE_TIMEOUT = 60 * 60 * 1000;
const DEFAULT_POLL_INTERVAL = 60 * 1000;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [command, ...rest] = args;
  if (!command || command === "-h" || command === "--help") {
    printHelp();
    return;
  }
  switch (command) {
    case "new":
      await commandNew(rest);
      return;
    case "run":
      await commandRun(rest);
      return;
    case "stage":
      await commandStage(rest);
      return;
    case "list":
      commandList();
      return;
    case "show":
      commandShow(rest);
      return;
    case "login":
      await commandLogin(rest);
      return;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exitCode = 1;
  }
}

function printHelp(): void {
  console.log(`ytauto — automated long-form video pipeline (codex + gpt-image-2 + Runway + ffmpeg)

Usage:
  ytauto new "<idea>" [--slug <slug>] [--segments N]
  ytauto run <slug> [--from <stage>] [--to <stage>] [--concurrency N] [--profile <dir>]
  ytauto stage <slug> <stage>      # ideate | artifacts | frames | generate | stitch
  ytauto list
  ytauto show <slug>
  ytauto login [--profile <dir>]

Pipeline stages (idempotent, re-runnable):
  ideate     — codex generates title, characters, settings, segments, narration
  artifacts  — gpt-image-2 generates a reference image per character/setting/prop
  frames     — gpt-image-2 generates a first-frame still per segment
  generate   — Runway Seedance 2.0 generates each segment in parallel (max 2)
  stitch     — ffmpeg concats segments into final.mp4
  polish     — burn title cards + mix TTS narration (edge-tts) into final.mp4
`);
}

async function commandNew(args: string[]): Promise<void> {
  const positional = args.filter((arg, i) => !arg.startsWith("--") && !(args[i - 1]?.startsWith("--") && !args[i - 1]?.includes("=") && i > 0 ? false : false));
  const idea = positional.find((p) => p && !p.startsWith("--"));
  if (!idea) {
    throw new Error("ytauto new requires an idea string");
  }
  const slugFlag = readFlag(args, "--slug");
  const segmentCount = Number(readFlag(args, "--segments") ?? "6");
  const cwd = process.cwd();
  const slugBase = slugFlag ?? slugify(idea);
  const slug = slugFlag ? slugFlag : uniqueSlug(slugBase, cwd);
  ensureProjectDirs(slug, cwd);
  const manifest = createManifest(slug, idea);
  saveManifest(manifest, cwd);
  writeFileSync(manifestPath(slug, cwd) + ".bak", JSON.stringify(manifest, null, 2));
  const log = createLogger();
  log(`new project ${slug} -> ${manifestPath(slug, cwd)}`);
  await runIdeate(manifest, { codexModel: DEFAULT_CODEX_MODEL, cwd, segmentCount, log });
  log("ideate complete. Run 'ytauto run " + slug + "' to continue with artifacts/frames/generate/stitch.");
}

async function commandRun(args: string[]): Promise<void> {
  const slug = args.find((arg) => !arg.startsWith("--"));
  if (!slug) throw new Error("ytauto run requires a slug");
  const cwd = process.cwd();
  const manifest = loadManifest(slug, cwd);
  const fromStage = (readFlag(args, "--from") ?? STAGE_ORDER[0]) as StageName;
  const toStage = (readFlag(args, "--to") ?? STAGE_ORDER[STAGE_ORDER.length - 1]) as StageName;
  const concurrency = Number(readFlag(args, "--concurrency") ?? DEFAULT_CONCURRENCY);
  const profileDir = resolve(cwd, readFlag(args, "--profile") ?? DEFAULT_PROFILE_DIR);

  const fromIdx = STAGE_ORDER.indexOf(fromStage);
  const toIdx = STAGE_ORDER.indexOf(toStage);
  if (fromIdx < 0 || toIdx < 0 || fromIdx > toIdx) {
    throw new Error(`invalid stage range: ${fromStage} -> ${toStage}`);
  }

  const log = createLogger();
  for (const stage of STAGE_ORDER.slice(fromIdx, toIdx + 1)) {
    if (manifest.stages[stage].status === "done") {
      log(`[${stage}] already done; skipping (use 'ytauto stage ${slug} ${stage}' to force)`);
      continue;
    }
    log(`---- stage ${stage} ----`);
    await runStage(manifest, stage, { cwd, profileDir, concurrency, log });
  }
  log(`---- DONE ${slug} ----`);
  if (manifest.finalPath) {
    log(`final video: ${manifest.finalPath}`);
  }
}

async function commandStage(args: string[]): Promise<void> {
  const slug = args[0];
  const stage = args[1] as StageName | undefined;
  if (!slug || !stage) throw new Error("ytauto stage requires <slug> <stage>");
  if (!STAGE_ORDER.includes(stage)) {
    throw new Error(`unknown stage: ${stage}; valid: ${STAGE_ORDER.join(", ")}`);
  }
  const cwd = process.cwd();
  const manifest = loadManifest(slug, cwd);
  // Force re-run of this single stage
  manifest.stages[stage].status = "pending";
  saveManifest(manifest, cwd);
  const concurrency = Number(readFlag(args, "--concurrency") ?? DEFAULT_CONCURRENCY);
  const profileDir = resolve(cwd, readFlag(args, "--profile") ?? DEFAULT_PROFILE_DIR);
  const log = createLogger();
  await runStage(manifest, stage, { cwd, profileDir, concurrency, log });
  log(`[${stage}] complete`);
}

async function runStage(
  manifest: Manifest,
  stage: StageName,
  ctx: { cwd: string; profileDir: string; concurrency: number; log: (msg: string) => void }
): Promise<void> {
  switch (stage) {
    case "ideate":
      await runIdeate(manifest, { codexModel: DEFAULT_CODEX_MODEL, cwd: ctx.cwd, log: ctx.log });
      return;
    case "artifacts":
      await runArtifacts(manifest, { cwd: ctx.cwd, log: ctx.log });
      return;
    case "frames":
      await runFrames(manifest, { cwd: ctx.cwd, log: ctx.log });
      return;
    case "generate":
      await runGenerate(manifest, {
        cwd: ctx.cwd,
        log: ctx.log,
        profileDir: ctx.profileDir,
        generationUrl: DEFAULT_GEN_URL,
        generationTimeoutMs: DEFAULT_GEN_TIMEOUT,
        upscaleTimeoutMs: DEFAULT_UPSCALE_TIMEOUT,
        pollIntervalMs: DEFAULT_POLL_INTERVAL,
        concurrency: ctx.concurrency
      });
      return;
    case "stitch":
      await runStitch(manifest, { cwd: ctx.cwd, log: ctx.log });
      return;
    case "polish":
      await runPolish(manifest, { cwd: ctx.cwd, log: ctx.log });
      return;
  }
}

function commandList(): void {
  const projects = listProjects();
  if (projects.length === 0) {
    console.log("no projects yet. start with: ytauto new \"<idea>\"");
    return;
  }
  console.log(projects.map((p) => `${p.slug.padEnd(32)}  ${stageSummary(p)}  ${p.title || p.idea.slice(0, 40)}`).join("\n"));
}

function stageSummary(manifest: Manifest): string {
  return STAGE_ORDER.map((s) => {
    const status = manifest.stages[s].status;
    const symbol = status === "done" ? "✓" : status === "running" ? "…" : status === "failed" ? "✗" : status === "skipped" ? "-" : "·";
    return `${s[0]}${symbol}`;
  }).join(" ");
}

function commandShow(args: string[]): void {
  const slug = args[0];
  if (!slug) throw new Error("ytauto show requires a slug");
  const manifest = loadManifest(slug);
  console.log(JSON.stringify(manifest, null, 2));
}

async function commandLogin(args: string[]): Promise<void> {
  const profileDir = resolve(process.cwd(), readFlag(args, "--profile") ?? DEFAULT_PROFILE_DIR);
  console.log(`[login] launching Chrome with profile ${profileDir}`);
  const context = await launchContext(profileDir);
  try {
    const page = context.pages()[0] ?? await context.newPage();
    const ok = await waitForLogin(page, DEFAULT_GEN_URL);
    console.log(ok ? "[login] signed in. Profile saved." : "[login] timed out without detecting sign-in.");
    if (!ok) process.exitCode = 1;
  } finally {
    await context.close();
  }
}

function readFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function createLogger(): (msg: string) => void {
  return (msg: string) => {
    const ts = new Date().toISOString().replace("T", " ").replace("Z", "");
    console.log(`[${ts}] ${msg}`);
  };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

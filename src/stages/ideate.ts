import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { extractJson, runCodexText } from "../codex.js";
import { saveManifest, setStageStatus, projectDir } from "../manifest.js";
import type { Aspect, Manifest, Model, Resolution } from "../types.js";

interface IdeateRaw {
  title: string;
  logline: string;
  characters: Array<{ name: string; description: string }>;
  settings: Array<{ name: string; description: string }>;
  segments: Array<{
    name: string;
    prompt: string;
    duration?: number;
    refs?: string[];
    firstFrameDescription?: string | null;
  }>;
}

export interface IdeateOptions {
  segmentCount?: number;
  codexModel: string;
  cwd?: string;
  log: (msg: string) => void;
}

export async function runIdeate(manifest: Manifest, options: IdeateOptions): Promise<Manifest> {
  const cwd = options.cwd ?? process.cwd();
  if (manifest.stages.ideate.status === "done" && manifest.segments.length > 0) {
    options.log("[ideate] already done; skipping (delete segments + clear stage status to redo)");
    return manifest;
  }
  const template = readFileSync(resolve(cwd, "prompts/ideate.md"), "utf8");
  const prompt = template
    .replace("{{idea}}", manifest.idea)
    .replace("{{segmentCount}}", String(options.segmentCount ?? 6));
  setStageStatus(manifest, "ideate", "running");
  saveManifest(manifest, cwd);
  options.log("[ideate] calling codex");
  const raw = await runCodexText(prompt, { model: options.codexModel, cwd });
  const parsed = JSON.parse(extractJson(raw)) as IdeateRaw;
  validate(parsed);
  manifest.title = parsed.title;
  manifest.logline = parsed.logline;
  manifest.characters = parsed.characters.map((c) => ({ name: kebab(c.name), description: c.description }));
  manifest.settings = parsed.settings.map((s) => ({ name: kebab(s.name), description: s.description }));
  manifest.segments = parsed.segments.map((s, i) => ({
    name: s.name ? kebab(s.name) : `seg-${String(i + 1).padStart(2, "0")}`,
    prompt: s.prompt,
    duration: clampDuration(s.duration ?? manifest.defaults.duration),
    aspect: manifest.defaults.aspect as Aspect,
    model: manifest.defaults.model as Model,
    resolution: manifest.defaults.resolution as Resolution,
    upscale: manifest.defaults.upscale,
    refs: (s.refs ?? []).map(kebab),
    firstFrameDescription: s.firstFrameDescription ?? undefined
  }));
  setStageStatus(manifest, "ideate", "done");
  saveManifest(manifest, cwd);
  writeFileSync(join(projectDir(manifest.slug, cwd), "script.md"), buildScriptMarkdown(manifest));
  options.log(`[ideate] ${manifest.segments.length} segments, ${manifest.characters.length} character(s), ${manifest.settings.length} setting(s)`);
  return manifest;
}

function validate(parsed: IdeateRaw): void {
  if (!parsed.title || !parsed.logline) {
    throw new Error("ideate output missing title/logline");
  }
  if (!Array.isArray(parsed.segments) || parsed.segments.length === 0) {
    throw new Error("ideate output has no segments");
  }
  if (!Array.isArray(parsed.characters)) {
    throw new Error("ideate output has no characters array");
  }
  if (!Array.isArray(parsed.settings)) {
    throw new Error("ideate output has no settings array");
  }
}

function kebab(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function clampDuration(value: number): number {
  if (!Number.isFinite(value)) return 15;
  return Math.max(4, Math.min(15, Math.round(value)));
}

function buildScriptMarkdown(manifest: Manifest): string {
  const lines = [`# ${manifest.title}`, "", manifest.logline, "", "## Characters", ""];
  for (const c of manifest.characters) {
    lines.push(`- **${c.name}** — ${c.description}`);
  }
  lines.push("", "## Settings", "");
  for (const s of manifest.settings) {
    lines.push(`- **${s.name}** — ${s.description}`);
  }
  lines.push("", "## Segments", "");
  for (const seg of manifest.segments) {
    lines.push(`### ${seg.name} (${seg.duration}s, refs: ${seg.refs.join(", ") || "none"})`);
    lines.push(seg.prompt);
    if (seg.firstFrameDescription) {
      lines.push("", `_first frame:_ ${seg.firstFrameDescription}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_DEFAULTS, STAGE_ORDER, type Manifest, type StageName, type StageStatus } from "./types.js";

export function projectsRoot(cwd = process.cwd()): string {
  return resolve(cwd, "projects");
}

export function projectDir(slug: string, cwd = process.cwd()): string {
  return resolve(projectsRoot(cwd), slug);
}

export function manifestPath(slug: string, cwd = process.cwd()): string {
  return join(projectDir(slug, cwd), "manifest.json");
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || `project-${Date.now()}`;
}

export function uniqueSlug(base: string, cwd = process.cwd()): string {
  let candidate = base;
  let n = 1;
  while (existsSync(projectDir(candidate, cwd))) {
    n++;
    candidate = `${base}-${n}`;
  }
  return candidate;
}

export function ensureProjectDirs(slug: string, cwd = process.cwd()): void {
  const dir = projectDir(slug, cwd);
  for (const sub of ["", "artifacts", "frames", "segments"]) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
}

export function createManifest(slug: string, idea: string): Manifest {
  const now = new Date().toISOString();
  const stages = STAGE_ORDER.reduce<Manifest["stages"]>((acc, name) => {
    acc[name] = { status: "pending" };
    return acc;
  }, {} as Manifest["stages"]);
  return {
    slug,
    idea,
    title: "",
    logline: "",
    createdAt: now,
    updatedAt: now,
    defaults: { ...DEFAULT_DEFAULTS },
    characters: [],
    settings: [],
    props: [],
    segments: [],
    stages
  };
}

export function loadManifest(slug: string, cwd = process.cwd()): Manifest {
  const path = manifestPath(slug, cwd);
  if (!existsSync(path)) {
    throw new Error(`Project not found: ${slug} (no manifest at ${path})`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

export function saveManifest(manifest: Manifest, cwd = process.cwd()): void {
  manifest.updatedAt = new Date().toISOString();
  const path = manifestPath(manifest.slug, cwd);
  writeFileSync(path, JSON.stringify(manifest, null, 2));
}

export function setStageStatus(manifest: Manifest, stage: StageName, status: StageStatus, error?: string): void {
  const entry = manifest.stages[stage];
  entry.status = status;
  entry.error = error;
  if (status === "done") {
    entry.completedAt = new Date().toISOString();
  }
}

export function listProjects(cwd = process.cwd()): Manifest[] {
  const root = projectsRoot(cwd);
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((slug) => existsSync(manifestPath(slug, cwd)))
    .map((slug) => loadManifest(slug, cwd))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

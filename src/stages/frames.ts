import { existsSync } from "node:fs";
import { join } from "node:path";
import { generateImage } from "../imagegen.js";
import { projectDir, saveManifest, setStageStatus } from "../manifest.js";
import type { Manifest } from "../types.js";

export interface FramesOptions {
  cwd?: string;
  log: (msg: string) => void;
}

export async function runFrames(manifest: Manifest, options: FramesOptions): Promise<Manifest> {
  const cwd = options.cwd ?? process.cwd();
  setStageStatus(manifest, "frames", "running");
  saveManifest(manifest, cwd);

  const dir = join(projectDir(manifest.slug, cwd), "frames");
  const refLookup = new Map<string, string>();
  for (const c of manifest.characters) {
    if (c.imagePath) refLookup.set(c.name, c.imagePath);
  }
  for (const s of manifest.settings) {
    if (s.imagePath) refLookup.set(s.name, s.imagePath);
  }

  for (const segment of manifest.segments) {
    if (!segment.firstFrameDescription) {
      options.log(`[frames] ${segment.name}: no firstFrameDescription, skipping`);
      continue;
    }
    if (segment.firstFrameImagePath && existsSync(segment.firstFrameImagePath)) {
      options.log(`[frames] ${segment.name}: already exists, skipping`);
      continue;
    }
    const path = join(dir, `${segment.name}.png`);
    const refs = segment.refs.map((name) => refLookup.get(name)).filter((value): value is string => Boolean(value));
    options.log(`[frames] ${segment.name}: generating with ${refs.length} ref(s)`);
    await generateImage({
      prompt: `${segment.firstFrameDescription} — first-frame still for a video segment, photorealistic, consistent with attached references. No captions, no text, no overlays.`,
      outPath: path,
      refs
    });
    segment.firstFrameImagePath = path;
    saveManifest(manifest, cwd);
    options.log(`[frames] ${segment.name}: saved -> ${path}`);
  }

  setStageStatus(manifest, "frames", "done");
  saveManifest(manifest, cwd);
  return manifest;
}

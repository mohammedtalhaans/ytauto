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

  // Build a name → kind lookup so we can label each ref by its role in the prompt
  const kindLookup = new Map<string, "character" | "setting">();
  for (const c of manifest.characters) kindLookup.set(c.name, "character");
  for (const s of manifest.settings) kindLookup.set(s.name, "setting");

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
    const refNames = segment.refs.filter((name) => refLookup.has(name));
    const refs = refNames.map((name) => refLookup.get(name)!).filter(Boolean);
    options.log(`[frames] ${segment.name}: generating with ${refs.length} ref(s)`);

    // Multi-ref edit prompt with explicit per-image role labels and a
    // preservation clause — the documented gpt-image-2 pattern for
    // identity + scene composition.
    const refLabels = refNames.map((name, i) => {
      const kind = kindLookup.get(name) ?? "reference";
      return `Image ${i + 1}: ${kind} reference — ${name}`;
    });
    const charRefs = refNames.filter((n) => kindLookup.get(n) === "character");
    const settingRefs = refNames.filter((n) => kindLookup.get(n) === "setting");
    const preserveLines: string[] = [];
    if (charRefs.length > 0) {
      preserveLines.push(
        `Preserve from the character reference(s) (${charRefs.join(", ")}): face, hair, clothing, body proportions — exactly. Do not redesign the character.`
      );
    }
    if (settingRefs.length > 0) {
      preserveLines.push(
        `Preserve from the setting reference(s) (${settingRefs.join(", ")}): room layout, furniture placement, lighting direction, color palette — exactly.`
      );
    }
    const prompt = [
      ...refLabels,
      "",
      `Compose the character into the scene. ${segment.firstFrameDescription.trim().replace(/\.$/, "")}.`,
      ...preserveLines,
      "Match character shadow and scale to the room's lighting direction.",
      "Photorealistic. Cinematic medium shot. Sharp focus. 16:9 aspect.",
      "No text. No watermark. No on-screen graphics."
    ].join("\n");

    await generateImage({ prompt, outPath: path, refs });
    segment.firstFrameImagePath = path;
    saveManifest(manifest, cwd);
    options.log(`[frames] ${segment.name}: saved -> ${path}`);
  }

  setStageStatus(manifest, "frames", "done");
  saveManifest(manifest, cwd);
  return manifest;
}

import { existsSync } from "node:fs";
import { join } from "node:path";
import { generateImage } from "../imagegen.js";
import { projectDir, saveManifest, setStageStatus } from "../manifest.js";
import type { Manifest } from "../types.js";

export interface FramesOptions {
  cwd?: string;
  log: (msg: string) => void;
}

type Kind = "character" | "setting" | "prop";

export async function runFrames(manifest: Manifest, options: FramesOptions): Promise<Manifest> {
  const cwd = options.cwd ?? process.cwd();
  setStageStatus(manifest, "frames", "running");
  saveManifest(manifest, cwd);

  const dir = join(projectDir(manifest.slug, cwd), "frames");

  // Build name → imagePath and name → kind lookups across characters,
  // settings, and props. The first-frame composition includes ALL
  // referenced artifacts (character + setting + props) so identity AND
  // setting AND key prop appearance are anchored from the very first frame.
  const refLookup = new Map<string, string>();
  const kindLookup = new Map<string, Kind>();
  for (const c of manifest.characters) {
    if (c.imagePath) refLookup.set(c.name, c.imagePath);
    kindLookup.set(c.name, "character");
  }
  for (const s of manifest.settings) {
    if (s.imagePath) refLookup.set(s.name, s.imagePath);
    kindLookup.set(s.name, "setting");
  }
  for (const p of manifest.props) {
    if (p.imagePath) refLookup.set(p.name, p.imagePath);
    kindLookup.set(p.name, "prop");
  }

  for (const segment of manifest.segments) {
    if (!segment.firstFrameDescription) {
      // ideate now forces a firstFrameDescription on every segment, but
      // tolerate manual edits that delete one (they can re-add manually).
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
    options.log(`[frames] ${segment.name}: generating with ${refs.length} ref(s) (${refNames.join(", ") || "none"})`);

    // Multi-ref edit prompt with explicit per-image role labels and a
    // preservation clause — the documented gpt-image-2 pattern for
    // identity + scene composition.
    const refLabels = refNames.map((name, i) => {
      const kind = kindLookup.get(name) ?? "reference";
      return `Image ${i + 1}: ${kind} reference — ${name}`;
    });
    const charRefs = refNames.filter((n) => kindLookup.get(n) === "character");
    const settingRefs = refNames.filter((n) => kindLookup.get(n) === "setting");
    const propRefs = refNames.filter((n) => kindLookup.get(n) === "prop");

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
    if (propRefs.length > 0) {
      preserveLines.push(
        `Preserve from the prop reference(s) (${propRefs.join(", ")}): exact shape, material, colour, engravings or marks — pixel-faithful. The same physical object must appear.`
      );
    }
    // Inject style bible cues so the first frame already matches the look
    // the video will inherit.
    const styleLine = manifest.style
      ? `Match the global look: ${manifest.style.lens}. Grade: ${manifest.style.grade}. Stock: ${manifest.style.filmStock}.`
      : "Photorealistic. Cinematic medium shot. Sharp focus.";

    const prompt = [
      ...refLabels,
      "",
      `Compose the scene. ${segment.firstFrameDescription.trim().replace(/\.$/, "")}.`,
      ...preserveLines,
      "Match character shadow and scale to the room's lighting direction.",
      styleLine,
      "9:16 portrait aspect.",
      "No text. No watermark. No on-screen graphics. No subtitles."
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

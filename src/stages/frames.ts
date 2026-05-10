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

/**
 * Frames stage — generates the FIRST and LAST frame PNG for every segment.
 *
 * Seedance 2.0 supports start↔end frame interpolation: if you provide both
 * a first-frame and a last-frame image, it generates a video that begins
 * at first-frame and ends at last-frame. This gives us TWO huge wins:
 *
 *   1. Per-segment composition control — the segment is bookended by
 *      gpt-image-2-rendered keyframes that already preserve character +
 *      setting + prop identity from refs.
 *   2. Cross-segment continuity — for non-final segments, the pipeline
 *      auto-syncs segment[i].lastFrameDescription = segment[i+1].first-
 *      FrameDescription. The frames stage detects this match and REUSES
 *      the same PNG file across the cut so segment N's ending image and
 *      segment N+1's opening image are identical pixels. The cut between
 *      stitched segments becomes invisible at the model level, not just
 *      the prompt level.
 *
 * For the final segment, lastFrameDescription is unique and gets its own
 * PNG generated.
 */
export async function runFrames(manifest: Manifest, options: FramesOptions): Promise<Manifest> {
  const cwd = options.cwd ?? process.cwd();
  setStageStatus(manifest, "frames", "running");
  saveManifest(manifest, cwd);

  const dir = join(projectDir(manifest.slug, cwd), "frames");

  // Build name → imagePath and name → kind lookups across characters,
  // settings, and props. Both first AND last frame compositions inherit
  // the same multi-ref preservation flow.
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

  // ---- Pass 1: generate firstFrameImagePath for every segment ----
  for (const segment of manifest.segments) {
    if (!segment.firstFrameDescription) {
      options.log(`[frames] ${segment.name}: no firstFrameDescription, skipping firstFrame`);
      continue;
    }
    if (segment.firstFrameImagePath && existsSync(segment.firstFrameImagePath)) {
      options.log(`[frames] ${segment.name}: firstFrame already exists, skipping`);
      continue;
    }
    const path = join(dir, `${segment.name}.png`);
    await generateFrame({
      manifest,
      segment,
      description: segment.firstFrameDescription,
      outPath: path,
      role: "first",
      refLookup,
      kindLookup,
      log: options.log
    });
    segment.firstFrameImagePath = path;
    saveManifest(manifest, cwd);
  }

  // ---- Pass 2: link non-final lastFrame to next segment's firstFrame ----
  // After firstFrames are all generated, walk the segments and reuse the
  // file for any non-final segment whose lastFrameDescription matches the
  // next segment's firstFrameDescription (which the ideate stage already
  // synchronized — it's the canonical case).
  for (let i = 0; i < manifest.segments.length - 1; i++) {
    const seg = manifest.segments[i];
    const next = manifest.segments[i + 1];
    if (
      seg.lastFrameDescription &&
      next.firstFrameDescription &&
      seg.lastFrameDescription.trim() === next.firstFrameDescription.trim() &&
      next.firstFrameImagePath &&
      existsSync(next.firstFrameImagePath)
    ) {
      seg.lastFrameImagePath = next.firstFrameImagePath;
      options.log(
        `[frames] ${seg.name}: lastFrame reuses ${next.name}'s firstFrame -> ${seg.lastFrameImagePath} (continuity bridge, no extra gen)`
      );
    }
  }

  // ---- Pass 3: generate any remaining lastFrames (typically just the final segment) ----
  for (const segment of manifest.segments) {
    if (!segment.lastFrameDescription) continue;
    if (segment.lastFrameImagePath && existsSync(segment.lastFrameImagePath)) continue;
    const path = join(dir, `${segment.name}-last.png`);
    await generateFrame({
      manifest,
      segment,
      description: segment.lastFrameDescription,
      outPath: path,
      role: "last",
      refLookup,
      kindLookup,
      log: options.log
    });
    segment.lastFrameImagePath = path;
    saveManifest(manifest, cwd);
  }

  setStageStatus(manifest, "frames", "done");
  saveManifest(manifest, cwd);
  return manifest;
}

interface GenerateFrameArgs {
  manifest: Manifest;
  segment: Manifest["segments"][number];
  description: string;
  outPath: string;
  role: "first" | "last";
  refLookup: Map<string, string>;
  kindLookup: Map<string, Kind>;
  log: (msg: string) => void;
}

async function generateFrame(args: GenerateFrameArgs): Promise<void> {
  const { manifest, segment, description, outPath, role, refLookup, kindLookup, log } = args;
  const refNames = segment.refs.filter((name) => refLookup.has(name));
  const refs = refNames.map((name) => refLookup.get(name)!).filter(Boolean);
  log(`[frames] ${segment.name}: generating ${role}Frame with ${refs.length} ref(s) (${refNames.join(", ") || "none"})`);

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
  const styleLine = manifest.style
    ? `Match the global look: ${manifest.style.lens}. Grade: ${manifest.style.grade}. Stock: ${manifest.style.filmStock}.`
    : "Photorealistic. Cinematic medium shot. Sharp focus.";

  const prompt = [
    ...refLabels,
    "",
    `Compose the scene. ${description.trim().replace(/\.$/, "")}.`,
    ...preserveLines,
    "Match character shadow and scale to the room's lighting direction.",
    styleLine,
    "9:16 portrait aspect.",
    "No text. No watermark. No on-screen graphics. No subtitles."
  ].join("\n");

  await generateImage({ prompt, outPath, refs });
  log(`[frames] ${segment.name}: ${role}Frame saved -> ${outPath}`);
}

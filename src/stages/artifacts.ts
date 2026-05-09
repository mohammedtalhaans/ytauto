import { existsSync } from "node:fs";
import { join } from "node:path";
import { generateImage } from "../imagegen.js";
import { projectDir, saveManifest, setStageStatus } from "../manifest.js";
import type { Asset, Manifest } from "../types.js";

export interface ArtifactsOptions {
  cwd?: string;
  log: (msg: string) => void;
}

export async function runArtifacts(manifest: Manifest, options: ArtifactsOptions): Promise<Manifest> {
  const cwd = options.cwd ?? process.cwd();
  setStageStatus(manifest, "artifacts", "running");
  saveManifest(manifest, cwd);

  await generateAssetGroup(manifest, manifest.characters, "character", options, cwd);
  await generateAssetGroup(manifest, manifest.settings, "setting", options, cwd);

  setStageStatus(manifest, "artifacts", "done");
  saveManifest(manifest, cwd);
  return manifest;
}

async function generateAssetGroup(
  manifest: Manifest,
  group: Asset[],
  kind: "character" | "setting",
  options: ArtifactsOptions,
  cwd: string
): Promise<void> {
  const dir = join(projectDir(manifest.slug, cwd), "artifacts");
  for (const asset of group) {
    const fileName = `${kind}-${asset.name}.png`;
    const path = join(dir, fileName);
    if (asset.imagePath && existsSync(asset.imagePath)) {
      options.log(`[artifacts] ${kind} ${asset.name}: skipping (already exists)`);
      continue;
    }
    if (existsSync(path)) {
      asset.imagePath = path;
      saveManifest(manifest, cwd);
      options.log(`[artifacts] ${kind} ${asset.name}: detected existing file, linked`);
      continue;
    }
    const prompt = buildPrompt(kind, asset);
    options.log(`[artifacts] ${kind} ${asset.name}: generating`);
    await generateImage({ prompt, outPath: path });
    asset.imagePath = path;
    saveManifest(manifest, cwd);
    options.log(`[artifacts] ${kind} ${asset.name}: saved -> ${path}`);
  }
}

function buildPrompt(kind: "character" | "setting", asset: Asset): string {
  if (kind === "character") {
    return [
      "Photorealistic full-body character reference sheet.",
      asset.description.trim().replace(/\.$/, "") + ".",
      "Neutral standing pose, front-facing, arms relaxed at sides.",
      "Plain light grey background. Flat even studio lighting, no harsh shadows.",
      "85mm portrait lens feel, sharp focus throughout.",
      "Visible skin pores, fabric texture, fine hair detail.",
      "No motion blur. No text. No watermark. No logos.",
      "Portrait aspect 2:3."
    ].join(" ");
  }
  return [
    `Photorealistic interior photograph of ${asset.name.replace(/-/g, " ")}.`,
    asset.description.trim().replace(/\.$/, "") + ".",
    "No people. No figures. No text. No watermark.",
    "Medium-wide shot, eye-level, 28mm equivalent.",
    "Sharp throughout. Clean cinematic feel. 16:9 aspect."
  ].join(" ");
}

import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { extractJson, runCodexText } from "../codex.js";
import { generateImage } from "../imagegen.js";
import { projectDir, saveManifest, setStageStatus } from "../manifest.js";
import type { Asset, Manifest, StyleBible } from "../types.js";

export interface ArtifactsOptions {
  cwd?: string;
  log: (msg: string) => void;
  codexModel?: string;       // for critique pass; defaults to gpt-5.5
  critique?: boolean;        // default true
}

type Kind = "character" | "setting" | "prop";

const CRITIQUE_THRESHOLD = 7; // 1-10 scale; below this triggers ONE regeneration

export async function runArtifacts(manifest: Manifest, options: ArtifactsOptions): Promise<Manifest> {
  const cwd = options.cwd ?? process.cwd();
  setStageStatus(manifest, "artifacts", "running");
  saveManifest(manifest, cwd);

  await generateAssetGroup(manifest, manifest.characters, "character", options, cwd);
  await generateAssetGroup(manifest, manifest.settings, "setting", options, cwd);
  await generateAssetGroup(manifest, manifest.props, "prop", options, cwd);

  setStageStatus(manifest, "artifacts", "done");
  saveManifest(manifest, cwd);
  return manifest;
}

async function generateAssetGroup(
  manifest: Manifest,
  group: Asset[],
  kind: Kind,
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
    const prompt = buildPrompt(kind, asset, manifest.style);
    options.log(`[artifacts] ${kind} ${asset.name}: generating`);
    await generateImage({ prompt, outPath: path });
    asset.imagePath = path;
    saveManifest(manifest, cwd);

    // Critique loop — codex looks at the generated image and scores it for
    // descriptor faithfulness. If poor, regenerate ONCE with critique
    // feedback prepended. Catches a wrong-ethnicity / wrong-clothing /
    // missing-prop artifact before it poisons every downstream segment.
    const useCritique = options.critique !== false;
    if (useCritique) {
      const verdict = await critiqueAsset({
        kind,
        asset,
        imagePath: path,
        codexModel: options.codexModel ?? "gpt-5.5",
        cwd,
        log: options.log
      });
      if (verdict && verdict.score < CRITIQUE_THRESHOLD) {
        options.log(`[artifacts] ${kind} ${asset.name}: critique score ${verdict.score}/10 — regenerating once with feedback`);
        const repromptHints = verdict.issues.length > 0
          ? "\nFix these specific issues from the previous attempt: " + verdict.issues.join("; ") + "."
          : "";
        const retryPrompt = buildPrompt(kind, asset, manifest.style) + repromptHints;
        try { unlinkSync(path); } catch { /* ignore */ }
        await generateImage({ prompt: retryPrompt, outPath: path });
        options.log(`[artifacts] ${kind} ${asset.name}: regenerated`);
      } else if (verdict) {
        options.log(`[artifacts] ${kind} ${asset.name}: critique score ${verdict.score}/10 — accepted`);
      }
    }

    options.log(`[artifacts] ${kind} ${asset.name}: saved -> ${path}`);
  }
}

interface CritiqueArgs {
  kind: Kind;
  asset: Asset;
  imagePath: string;
  codexModel: string;
  cwd: string;
  log: (msg: string) => void;
}

interface CritiqueVerdict {
  score: number;
  issues: string[];
}

async function critiqueAsset(args: CritiqueArgs): Promise<CritiqueVerdict | undefined> {
  const target = args.kind === "character"
    ? "a character reference sheet"
    : args.kind === "setting" ? "an empty setting / environment photo (no people)"
    : "a prop / object reference photo";
  const checklist = args.kind === "character"
    ? "age (must match exact years stated), ethnicity & skin tone, eye colour, hair colour & length & style, complete clothing top-to-bottom, distinguishing features (scars/glasses/tattoos), pose (neutral standing front-facing), background (plain light grey)"
    : args.kind === "setting"
    ? "room/location type, listed furniture & props, listed textures, time-of-day & light direction, colour palette, NO people present"
    : "material, colour, finish, size & shape, distinguishing marks/engraving, plain neutral background";
  const prompt = [
    `You are reviewing an AI-generated image meant to serve as ${target} for a video pipeline.`,
    `The image is attached. Compare it strictly to this descriptor:`,
    "",
    `"""`,
    args.asset.description,
    `"""`,
    "",
    `Checklist (each item must visibly match): ${checklist}.`,
    "",
    `Score the faithfulness 1-10 (10 = perfect match, 7 = acceptable, ≤6 = regenerate). List concrete visible mismatches.`,
    "",
    `Output strict JSON only, no commentary:`,
    `{ "score": <integer 1-10>, "issues": ["specific mismatch 1", "specific mismatch 2"] }`
  ].join("\n");
  try {
    const raw = await runCodexText(prompt, {
      model: args.codexModel,
      cwd: args.cwd,
      reasoningEffort: "medium",
      images: [args.imagePath],
      timeoutMs: 5 * 60 * 1000
    });
    const parsed = JSON.parse(extractJson(raw)) as CritiqueVerdict;
    if (typeof parsed.score !== "number") return undefined;
    parsed.issues = Array.isArray(parsed.issues) ? parsed.issues : [];
    return parsed;
  } catch (err) {
    args.log(`[artifacts] ${args.kind} ${args.asset.name}: critique failed (${(err as Error).message}) — accepting image as-is`);
    return undefined;
  }
}

function buildPrompt(kind: Kind, asset: Asset, style?: StyleBible): string {
  // Inject the style bible's lens + grade hint so artifacts already match the
  // look the videos will be rendered in. Don't include `motion` (artifacts
  // are stills) or `era` (we want a clean reference, not era-stylised).
  const styleHint = style
    ? ` Lens feel: ${style.lens}. Tonal palette: ${style.grade}.`
    : "";
  if (kind === "character") {
    return [
      "Photorealistic full-body character reference sheet.",
      asset.description.trim().replace(/\.$/, "") + ".",
      "Neutral standing pose, front-facing, arms relaxed at sides. Full body visible head to feet.",
      "Plain light grey seamless background. Flat even studio lighting, no harsh shadows.",
      "85mm portrait lens feel, sharp focus throughout.",
      "Visible skin pores, fabric texture, fine hair detail.",
      "No motion blur. No text. No watermark. No logos." + styleHint,
      "Portrait aspect 2:3."
    ].join(" ");
  }
  if (kind === "setting") {
    return [
      `Photorealistic interior photograph of ${asset.name.replace(/-/g, " ")}.`,
      asset.description.trim().replace(/\.$/, "") + ".",
      "No people. No figures. No text. No watermark.",
      "Medium-wide shot, eye-level, 28mm equivalent.",
      "Sharp throughout. Clean cinematic feel." + styleHint,
      "16:9 aspect."
    ].join(" ");
  }
  // prop
  return [
    `Photorealistic product-style reference photo of ${asset.name.replace(/-/g, " ")}.`,
    asset.description.trim().replace(/\.$/, "") + ".",
    "Centered in frame, plain neutral light grey background, soft even studio light.",
    "100mm macro lens feel, tack-sharp focus, fine surface detail visible.",
    "No people. No hands holding it. No text. No watermark." + styleHint,
    "Square 1:1 aspect."
  ].join(" ");
}

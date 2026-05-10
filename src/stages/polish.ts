import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, statSync, unlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { projectDir, saveManifest, setStageStatus } from "../manifest.js";
import type { Manifest } from "../types.js";

export interface PolishOptions {
  cwd?: string;
  log: (msg: string) => void;
}

/**
 * Polish stage — runs after stitch.
 *
 * 1. (optional, on by default) Generate TTS narration via edge-tts from
 *    `manifest.narrationScript`, save to `narration.mp3`.
 * 2. (optional, on by default) Build an ffmpeg filter graph that:
 *      - Burns segment-level location cards as drawtext overlays at the
 *        appropriate time windows (each card visible 0.3s fade-in,
 *        2s hold, 0.5s fade-out — total 2.8s starting at the segment's
 *        start in the stitched timeline).
 *      - Ducks the source audio (Seedance music + ambient + SFX) to 30%
 *        and mixes the TTS narration in over the top.
 * 3. Output overwrites `final.mp4` (raw stitch lives at `final.raw.mp4` if
 *    we want to keep it; for now we just overwrite — the raw clips are
 *    still present in projects/<slug>/segments/).
 *
 * If both narrate and titleCards are off, this stage is a no-op.
 *
 * Re-runnable: skips TTS generation if narration.mp3 already exists and
 * matches the current narrationScript (we just check existence — to force
 * regeneration delete narration.mp3 manually).
 */
export async function runPolish(manifest: Manifest, options: PolishOptions): Promise<Manifest> {
  const cwd = options.cwd ?? process.cwd();
  setStageStatus(manifest, "polish", "running");
  saveManifest(manifest, cwd);

  const wantNarration = manifest.defaults.narrate !== false && Boolean(manifest.narrationScript?.trim());
  const wantTitleCards = manifest.defaults.titleCards !== false && manifest.segments.some((s) => s.locationCard);

  if (!wantNarration && !wantTitleCards) {
    options.log("[polish] narrate=false and no titleCards — nothing to do, skipping");
    setStageStatus(manifest, "polish", "skipped");
    saveManifest(manifest, cwd);
    return manifest;
  }

  const dir = projectDir(manifest.slug, cwd);
  const finalPath = join(dir, "final.mp4");
  if (!existsSync(finalPath)) {
    throw new Error("[polish] final.mp4 not found — run stitch first");
  }

  // Use a working copy so we can overwrite final.mp4 at the end without
  // ffmpeg failing on "input is the same file as output".
  const stitchInput = join(dir, "final.stitch.mp4");
  if (existsSync(stitchInput)) unlinkSync(stitchInput);
  await runFfmpeg(["-y", "-i", finalPath, "-c", "copy", stitchInput], options.log);

  // ---- Narration ----
  let narrationPath: string | undefined;
  if (wantNarration) {
    narrationPath = join(dir, "narration.mp3");
    if (!existsSync(narrationPath)) {
      const voice = manifest.defaults.narrationVoice || "en-US-AriaNeural";
      options.log(`[polish] generating TTS narration (voice ${voice}, ${manifest.narrationScript!.length} chars) -> narration.mp3`);
      await runEdgeTts(manifest.narrationScript!, voice, narrationPath, options.log);
    } else {
      options.log("[polish] narration.mp3 already exists, reusing (delete to regenerate)");
    }
  }

  // ---- Build ffmpeg filter graph ----
  const titleCardFilters = wantTitleCards ? buildTitleCardFilters(manifest) : "";
  const filterGraph = buildFilterGraph({ titleCardFilters, hasNarration: Boolean(narrationPath) });

  const ffmpegArgs: string[] = ["-y", "-i", stitchInput];
  if (narrationPath) {
    ffmpegArgs.push("-i", narrationPath);
  }
  if (filterGraph) {
    ffmpegArgs.push("-filter_complex", filterGraph);
    ffmpegArgs.push("-map", "[vout]");
    ffmpegArgs.push("-map", narrationPath ? "[aout]" : "0:a");
  }
  // Re-encode video (drawtext requires it). Use a high-quality preset to
  // preserve the upscaled 4K source. Audio re-encoded as AAC.
  ffmpegArgs.push("-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p");
  ffmpegArgs.push("-c:a", "aac", "-b:a", "192k");
  ffmpegArgs.push(finalPath);

  options.log(`[polish] ffmpeg ${describeArgs(ffmpegArgs)}`);
  await runFfmpeg(ffmpegArgs, options.log);

  // Cleanup the working copy
  if (existsSync(stitchInput)) unlinkSync(stitchInput);

  setStageStatus(manifest, "polish", "done");
  saveManifest(manifest, cwd);

  const sizeMb = (statSync(finalPath).size / (1024 * 1024)).toFixed(1);
  options.log(`[polish] final -> ${finalPath} (${sizeMb} MB)`);
  return manifest;
}

interface FilterGraphArgs {
  titleCardFilters: string;
  hasNarration: boolean;
}

function buildFilterGraph(args: FilterGraphArgs): string {
  // Video chain: 0:v → optional drawtext filters → [vout]
  // Audio chain: 0:a (ducked to 30%) + 1:a (narration full) mixed → [aout]
  // If no narration, audio is just 0:a passthrough (no filter chain needed
  // for audio — handled by -map 0:a above when narration absent).
  const videoChain = args.titleCardFilters
    ? `[0:v]${args.titleCardFilters}[vout]`
    : `[0:v]copy[vout]`;
  if (!args.hasNarration) {
    return videoChain;
  }
  // Duck source audio to ~30% so narration sits clearly on top. Pad
  // narration to source length so amix duration=longest works without
  // truncation when narration is shorter (typical case).
  const audioChain = `[0:a]volume=0.3[a0];[1:a]apad[a1];[a0][a1]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`;
  return `${videoChain};${audioChain}`;
}

function buildTitleCardFilters(manifest: Manifest): string {
  // Cumulative time offset so each segment's card appears at its position
  // in the stitched timeline.
  const fontPath = pickFontPath();
  const filters: string[] = [];
  let offset = 0;
  // Optional global title card on segment 0 (if manifest.titleCard set, it
  // overrides segment[0].locationCard for the first segment's window).
  for (let i = 0; i < manifest.segments.length; i++) {
    const seg = manifest.segments[i];
    const cardText = i === 0 && manifest.titleCard ? manifest.titleCard : seg.locationCard;
    if (cardText) {
      const start = offset + 0.3;          // delay 0.3s into the segment
      const fadeIn = 0.3;
      const hold = 2.0;
      const fadeOut = 0.5;
      const end = start + fadeIn + hold + fadeOut;
      const escaped = escapeDrawtext(cardText);
      // Drop shadow + subtle scale for legibility on busy backgrounds.
      filters.push(buildDrawtext({
        fontPath,
        text: escaped,
        start,
        fadeIn,
        hold,
        fadeOut,
        end,
        position: "bottom-left"
      }));
    }
    offset += seg.duration;
  }
  return filters.join(",");
}

interface DrawtextArgs {
  fontPath: string | undefined;
  text: string;
  start: number;
  fadeIn: number;
  hold: number;
  fadeOut: number;
  end: number;
  position: "bottom-left" | "top-center";
}

function buildDrawtext(args: DrawtextArgs): string {
  const x = args.position === "bottom-left" ? "60" : "(w-text_w)/2";
  const y = args.position === "bottom-left" ? "h-text_h-80" : "80";
  // Alpha keyframes: fade-in over [start, start+fadeIn], hold,
  // fade-out over [end-fadeOut, end].
  const fadeInEnd = args.start + args.fadeIn;
  const fadeOutStart = args.end - args.fadeOut;
  const alphaExpr =
    `if(lt(t\\,${args.start})\\,0\\,` +
    `if(lt(t\\,${fadeInEnd})\\,(t-${args.start})/${args.fadeIn}\\,` +
    `if(lt(t\\,${fadeOutStart})\\,1\\,` +
    `if(lt(t\\,${args.end})\\,1-(t-${fadeOutStart})/${args.fadeOut}\\,0))))`;
  const fontParam = args.fontPath ? `:fontfile='${args.fontPath.replace(/\\/g, "/").replace(/:/g, "\\:")}'` : "";
  return (
    `drawtext=text='${args.text}'${fontParam}` +
    `:fontcolor=white@1.0:fontsize=44:borderw=3:bordercolor=black@0.85` +
    `:shadowcolor=black@0.7:shadowx=2:shadowy=2` +
    `:x=${x}:y=${y}` +
    `:enable='between(t,${args.start},${args.end})'` +
    `:alpha='${alphaExpr}'`
  );
}

function escapeDrawtext(text: string): string {
  // ffmpeg drawtext requires escaping single quotes, backslashes, colons,
  // and percent signs. We also strip newlines.
  return text
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/%/g, "\\%")
    .replace(/[\r\n]+/g, " ");
}

function pickFontPath(): string | undefined {
  // Try a few common font locations across platforms; return the first that
  // exists. If none, return undefined and ffmpeg will fall back to a
  // default font (which may not look great but won't fail).
  const candidates = [
    "C:/Windows/Fonts/arialbd.ttf",
    "C:/Windows/Fonts/arial.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"
  ];
  return candidates.find((p) => existsSync(p));
}

async function runEdgeTts(text: string, voice: string, outPath: string, log: (msg: string) => void): Promise<void> {
  mkdirSync(dirname(outPath), { recursive: true });
  // Write the text to a temp file and pass --file. Passing long multi-line
  // text via --text on Windows with shell=true mangles arg quoting.
  const tempDir = mkdtempSync(join(tmpdir(), "ytauto-tts-"));
  const textPath = join(tempDir, "narration.txt");
  writeFileSync(textPath, text, "utf8");
  try {
    await new Promise<void>((resolve, reject) => {
      const command = "python";
      const args = ["-m", "edge_tts", "--voice", voice, "--file", textPath, "--write-media", outPath];
      // No shell=true — python.exe resolves via PATH directly and shell-mode
      // mangles args containing spaces (paths like "yt automation").
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (err) => {
        reject(new Error(`[polish] python -m edge_tts spawn failed: ${err.message}. Install with: pip install edge-tts`));
      });
      child.on("close", (code) => {
        if (code === 0) {
          log(`[polish] TTS written -> ${outPath}`);
          resolve();
        } else {
          reject(new Error(`[polish] edge-tts exited ${code}: ${stderr.split(/\r?\n/).slice(-10).join("\n")}`));
        }
      });
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function runFfmpeg(args: string[], log: (msg: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        log(`[polish] ffmpeg failed; last stderr lines:\n${stderr.split(/\r?\n/).slice(-25).join("\n")}`);
        reject(new Error(`ffmpeg exited ${code}`));
      }
    });
  });
}

function describeArgs(args: string[]): string {
  // Truncate the filter_complex arg in logs since it can be very long.
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-filter_complex" && args[i + 1]) {
      out.push(a, args[i + 1].length > 80 ? `<filter graph, ${args[i + 1].length} chars>` : args[i + 1]);
      i++;
    } else {
      out.push(a);
    }
  }
  return out.join(" ");
}

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { projectDir, saveManifest, setStageStatus } from "../manifest.js";
import type { Manifest } from "../types.js";

export interface StitchOptions {
  cwd?: string;
  log: (msg: string) => void;
  reencode?: boolean;
}

export async function runStitch(manifest: Manifest, options: StitchOptions): Promise<Manifest> {
  const cwd = options.cwd ?? process.cwd();
  setStageStatus(manifest, "stitch", "running");
  saveManifest(manifest, cwd);

  const dir = projectDir(manifest.slug, cwd);
  const finalPath = join(dir, "final.mp4");
  const concatList = join(dir, "concat.txt");

  const segments = manifest.segments.filter((s) => s.videoPath && existsSync(s.videoPath));
  if (segments.length === 0) {
    throw new Error("[stitch] no segments with video files found; run generate first");
  }

  const lines = segments
    .map((s) => `file '${s.videoPath!.replace(/'/g, "'\\''")}'`)
    .join("\n");
  mkdirSync(dirname(concatList), { recursive: true });
  writeFileSync(concatList, `${lines}\n`);

  const args = options.reencode
    ? ["-y", "-f", "concat", "-safe", "0", "-i", concatList, "-c:v", "libx264", "-c:a", "aac", "-pix_fmt", "yuv420p", finalPath]
    : ["-y", "-f", "concat", "-safe", "0", "-i", concatList, "-c", "copy", finalPath];

  options.log(`[stitch] ffmpeg ${args.join(" ")}`);
  await runFfmpeg(args);

  manifest.finalPath = finalPath;
  setStageStatus(manifest, "stitch", "done");
  saveManifest(manifest, cwd);
  options.log(`[stitch] final -> ${finalPath}`);
  return manifest;
}

function runFfmpeg(args: string[]): Promise<void> {
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
        reject(new Error(`ffmpeg exited ${code}: ${stderr.split(/\r?\n/).slice(-15).join("\n")}`));
      }
    });
  });
}

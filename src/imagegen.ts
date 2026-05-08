import { spawn } from "node:child_process";
import type { Dirent } from "node:fs";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ImageGenOptions {
  prompt: string;
  outPath: string;
  refs?: string[];
  timeoutMs?: number;
  cwd?: string;
}

const SESSIONS_ROOT = join(homedir(), ".codex", "sessions");

const IMAGE_MAGIC: Array<{ prefix: string; ext: string }> = [
  { prefix: "iVBORw0KGgo", ext: "png" },
  { prefix: "/9j/", ext: "jpg" },
  { prefix: "UklGR", ext: "webp" }
];

const MIN_BLOB_LENGTH = 200;
const BASE64_BLOB_RE = new RegExp(`"([A-Za-z0-9+/=]{${MIN_BLOB_LENGTH},})"`, "g");

export async function generateImage(options: ImageGenOptions): Promise<string> {
  const refs = options.refs ?? [];
  for (const ref of refs) {
    if (!existsSync(ref)) {
      throw new Error(`reference image not found: ${ref}`);
    }
  }
  mkdirSync(SESSIONS_ROOT, { recursive: true });
  mkdirSync(dirname(options.outPath), { recursive: true });

  const before = listRolloutFiles(SESSIONS_ROOT);

  const args = [
    "exec",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--color",
    "never",
    "--enable",
    "image_generation"
  ];
  for (const ref of refs) {
    args.push("-i", ref);
  }

  const instruction = buildInstruction(options.prompt, refs.length > 0);
  await runCodex(args, instruction, options.cwd ?? process.cwd(), options.timeoutMs ?? 600000);

  const after = listRolloutFiles(SESSIONS_ROOT);
  const newFiles = diff(before, after);
  if (newFiles.length === 0) {
    throw new Error("imagegen: no new codex session rollout file detected");
  }
  const blob = findBestImageBlob(newFiles);
  if (!blob) {
    throw new Error("imagegen: no image payload found in session rollout (image_generation may be disabled or refused)");
  }
  const bytes = Buffer.from(blob, "base64");
  writeFileSync(options.outPath, bytes);
  return options.outPath;
}

function buildInstruction(prompt: string, hasRefs: boolean): string {
  let instruction = "Use the imagegen tool to generate the image for the following request.";
  if (hasRefs) {
    instruction += " Use the attached image(s) as visual reference / input for image-to-image.";
  }
  instruction += "\nRequirements: generate the image directly, return only the image, no explanation.\n\nRequest:\n";
  instruction += prompt;
  return instruction;
}

function listRolloutFiles(root: string): Set<string> {
  const result = new Set<string>();
  if (!existsSync(root)) {
    return result;
  }
  walk(root, (path) => {
    if (/rollout-.*\.jsonl$/i.test(path)) {
      result.add(path);
    }
  });
  return result;
}

function walk(dir: string, visit: (path: string) => void): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(path, visit);
    } else if (entry.isFile()) {
      visit(path);
    }
  }
}

function diff(before: Set<string>, after: Set<string>): string[] {
  const diff: string[] = [];
  for (const path of after) {
    if (!before.has(path)) {
      diff.push(path);
    }
  }
  return diff;
}

function findBestImageBlob(files: string[]): string | undefined {
  let best: { blob: string; length: number } | undefined;
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const flat = JSON.stringify(obj);
      let match: RegExpExecArray | null;
      BASE64_BLOB_RE.lastIndex = 0;
      while ((match = BASE64_BLOB_RE.exec(flat)) !== null) {
        const blob = match[1];
        if (IMAGE_MAGIC.some(({ prefix }) => blob.startsWith(prefix))) {
          if (!best || blob.length > best.length) {
            best = { blob, length: blob.length };
          }
        }
      }
    }
  }
  return best?.blob;
}

function runCodex(args: string[], stdin: string, cwd: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const command = process.platform === "win32" ? "codex.cmd" : "codex";
    const child = spawn(command, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32"
    });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`imagegen: codex exec timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`imagegen: codex exec failed (exit ${code}): ${stderr.split(/\r?\n/).slice(-15).join("\n")}`));
      }
    });
    child.stdin.end(stdin);
  });
}

// Tiny utility used by stages: fingerprint to skip already-generated images
export function fileFingerprint(path: string): string | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  const stat = statSync(path);
  return `${stat.size}:${Math.floor(stat.mtimeMs)}`;
}

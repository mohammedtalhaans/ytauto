import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CodexOptions {
  model: string;
  cwd?: string;
  timeoutMs?: number;
  reasoningEffort?: "low" | "medium" | "high";
  images?: string[];     // attach images for vision input (used by artifact critique)
}

export async function runCodexText(prompt: string, options: CodexOptions): Promise<string> {
  const tempDir = mkdtempSync(join(tmpdir(), "ytauto-codex-"));
  const outputPath = join(tempDir, "last-message.txt");
  const args = [
    "exec",
    "--model",
    options.model,
    "--skip-git-repo-check",
    "--sandbox",
    "workspace-write",
    "--output-last-message",
    outputPath
  ];
  if (options.reasoningEffort) {
    args.push("-c", `model_reasoning_effort=${options.reasoningEffort}`);
  }
  for (const image of options.images ?? []) {
    args.push("-i", image);
  }
  args.push("-");
  try {
    await runProcess(codexCommand(), args, prompt, options.cwd ?? process.cwd(), options.timeoutMs ?? 600000);
    return readFileSync(outputPath, "utf8").trim();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function codexCommand(): string {
  return process.platform === "win32" ? "codex.cmd" : "codex";
}

function runProcess(command: string, args: string[], input: string, cwd: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32"
    });
    let stderr = "";
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`codex command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
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
        reject(new Error(`codex exited ${code}: ${stderr || stdout}`));
      }
    });
    child.stdin.end(input);
  });
}

export function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    return fenced[1].trim();
  }
  const firstBrace = raw.indexOf("{");
  const firstBracket = raw.indexOf("[");
  const candidates: number[] = [];
  if (firstBrace >= 0) candidates.push(firstBrace);
  if (firstBracket >= 0) candidates.push(firstBracket);
  if (candidates.length === 0) {
    return raw.trim();
  }
  const start = Math.min(...candidates);
  const opener = raw[start];
  const closer = opener === "{" ? "}" : "]";
  const last = raw.lastIndexOf(closer);
  if (last > start) {
    return raw.slice(start, last + 1);
  }
  return raw.trim();
}

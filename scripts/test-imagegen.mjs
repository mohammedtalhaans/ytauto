import { generateImage } from "../dist/imagegen.js";
import { resolve } from "node:path";

const out = resolve("debug-out", `imagegen-test-${Date.now()}.png`);
console.log("[test] generating ->", out);
try {
  const result = await generateImage({
    prompt: "A friendly orange tabby cat sitting on a windowsill at sunrise, watercolor illustration, soft pastel colors, warm light. No text.",
    outPath: out,
    timeoutMs: 240000
  });
  console.log("[test] OK ->", result);
} catch (error) {
  console.error("[test] FAILED:", error instanceof Error ? error.message : String(error));
  process.exit(1);
}

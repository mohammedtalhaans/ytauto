// Repeat the configure + upload-refs flow exactly like ytauto runs it,
// then inspect what Runway shows.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const profileDir = resolve("runway-profile");
const outDir = resolve("debug-out");
mkdirSync(outDir, { recursive: true });

const ctx = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  viewport: { width: 1920, height: 1080 },
  channel: "chrome",
  acceptDownloads: true
});
const page = ctx.pages()[0] ?? await ctx.newPage();

const shot = (name) => page.screenshot({ path: resolve(outDir, `refs-${Date.now()}-${name}.png`), fullPage: true });

console.log("[dbg] navigate to home");
await page.goto("https://app.runwayml.com/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);

const promptBox = page.locator("[role='textbox'][aria-label='Prompt'][contenteditable='true']").first();
console.log("[dbg] promptBox visible?", await promptBox.isVisible({ timeout: 2000 }).catch(() => false));

// list ALL file inputs
const fileInputs = await page.locator("input[type='file']").all();
console.log("[dbg] number of input[type=file] on page:", fileInputs.length);
for (let i = 0; i < fileInputs.length; i++) {
  const attrs = await fileInputs[i].evaluate((el) => ({
    name: el.getAttribute("name"),
    accept: el.getAttribute("accept"),
    multiple: el.hasAttribute("multiple"),
    id: el.id,
    parentClass: el.parentElement?.className?.slice(0, 80) ?? "",
    visible: el.offsetWidth > 0 || el.offsetHeight > 0
  }));
  console.log(`  input[${i}]:`, JSON.stringify(attrs));
}

const refs = [
  resolve("projects/a-30-second-time-lapse-of-a-single-tulip-blooming-in-a-sunli/artifacts/character-tulip.png"),
  resolve("projects/a-30-second-time-lapse-of-a-single-tulip-blooming-in-a-sunli/artifacts/setting-windowsill.png"),
  resolve("projects/a-30-second-time-lapse-of-a-single-tulip-blooming-in-a-sunli/frames/01-morning-unfurl.png")
];

console.log("[dbg] uploading 3 refs to first file input");
const fileInput = page.locator("input[type='file']").first();
await fileInput.setInputFiles(refs);
await page.waitForTimeout(5000);
await shot("01-after-upload");

const fileInputsAfter = await page.locator("input[type='file']").all();
console.log("[dbg] number of input[type=file] AFTER upload:", fileInputsAfter.length);

// Show body text after upload
const bodyAfterUpload = await page.locator("body").innerText().catch(() => "");
console.log("[dbg] body after upload (first 1500 chars):");
console.log(bodyAfterUpload.slice(0, 1500));

// Fill prompt
console.log("[dbg] filling prompt");
await promptBox.click({ timeout: 10000 });
await page.keyboard.press("Control+A").catch(() => undefined);
await page.keyboard.press("Delete").catch(() => undefined);
await promptBox.fill("Cinematic 15s clip: a single red-pink tulip in a clear glass vase rests on a white sunlit windowsill. Macro camera, soft golden morning light. No subtitles, no captions, no visible text.");
await page.waitForTimeout(2000);
await shot("02-after-prompt");

console.log("[dbg] clicking Generate");
const genBtn = page.getByRole("button", { name: "Generate", exact: true }).first();
await genBtn.click({ timeout: 15000 });
await page.waitForTimeout(2500);
await shot("03-just-after-click");
console.log("[dbg] url after click:", page.url());

await page.waitForTimeout(8000);
await shot("04-10s-after-click");

const bodyAfter = await page.locator("body").innerText().catch(() => "");
console.log("[dbg] body 10s after click (first 2500 chars):");
console.log(bodyAfter.slice(0, 2500));

console.log("[dbg] waiting 60s before close");
await page.waitForTimeout(60000);
await ctx.close();

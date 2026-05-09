// Submit segment 02-full-bloom mirroring the same successful flow.
// Opens its own browser context (separate from the one that submitted seg 01).
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
const shot = (n) => page.screenshot({ path: resolve(outDir, `seg02-${Date.now()}-${n}.png`), fullPage: true });

console.log("[s02] navigate to home (will follow team redirect)");
await page.goto("https://app.runwayml.com/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);
console.log("[s02] start URL:", page.url());

// Configure 9:16 + 15s (1080p stays 720p, ignored)
const aspectTrigger = page.locator("button[aria-label='Aspect ratio']").first();
if ((await aspectTrigger.innerText().catch(() => "")).trim() !== "9:16") {
  await aspectTrigger.click();
  await page.waitForTimeout(700);
  await page.getByRole("option", { name: /^9:16$/ }).first().click();
  await page.waitForTimeout(700);
}
const durTrigger = page.locator("button[aria-label='Duration']").first();
if (!/^15\s*s$/i.test((await durTrigger.innerText().catch(() => "")).trim())) {
  await durTrigger.click();
  await page.waitForTimeout(700);
  await page.getByRole("option", { name: /^15\s*seconds?$/i }).first().click();
  await page.waitForTimeout(700);
}

// Upload segment 02 refs: tulip + windowsill + 02 first-frame
const refs = [
  resolve("projects/a-30-second-time-lapse-of-a-single-tulip-blooming-in-a-sunli/artifacts/character-tulip.png"),
  resolve("projects/a-30-second-time-lapse-of-a-single-tulip-blooming-in-a-sunli/artifacts/setting-windowsill.png"),
  resolve("projects/a-30-second-time-lapse-of-a-single-tulip-blooming-in-a-sunli/frames/02-full-bloom.png")
];
console.log("[s02] uploading refs");
const fileInput = page.locator("input[type='file']").first();
await fileInput.setInputFiles(refs);
const upDeadline = Date.now() + 60000;
while (Date.now() < upDeadline) {
  const body = await page.locator("body").innerText().catch(() => "");
  const matches = body.match(/\bIMG_\d+\b/g);
  const count = matches ? new Set(matches).size : 0;
  if (count >= 3 && !/started uploading|uploading\.\.\./i.test(body)) {
    console.log("[s02] all 3 refs visible");
    break;
  }
  await page.waitForTimeout(1500);
}
await page.waitForTimeout(1500);

// Real segment 02 prompt from manifest
const prompt = "Cinematic 15s time-lapse clip: the same single tulip continues blooming on the same sunlit windowsill, petals opening wider into a graceful full bloom as sunlight shifts across the sill, the glass vase catching bright highlights, leaves subtly lifting, natural realistic motion, serene locked-off camera, warm afternoon glow, delicate shadows on the wall. No subtitles, no captions, no visible text.";

console.log("[s02] filling prompt");
const promptBox = page.locator("[role='textbox'][aria-label='Prompt'][contenteditable='true']").first();
await promptBox.click();
await page.keyboard.press("Control+A");
await page.keyboard.press("Delete");
await promptBox.fill(prompt);
await page.waitForTimeout(1500);

console.log("[s02] click Generate (1)");
const genBtn = page.getByRole("button", { name: "Generate", exact: true }).first();
await genBtn.click({ timeout: 15000 });

// First click on fresh URL just creates a session record. Wait for sessionId
// to appear in URL, then click Generate AGAIN to actually queue.
const sessionDeadline = Date.now() + 30000;
while (Date.now() < sessionDeadline) {
  if (/[?&]sessionId=/i.test(page.url())) break;
  await page.waitForTimeout(1500);
}
console.log("[s02] url after click 1:", page.url());

// Maybe already queued (if start URL had a sessionId already)
const body1 = await page.locator("body").innerText().catch(() => "");
let queued = false;
if (/in queue|generation is in queue|generating/i.test(body1)) {
  console.log("[s02] QUEUED on click 1");
  queued = true;
  await shot("queued-1");
}

if (!queued) {
  console.log("[s02] click Generate (2)");
  await genBtn.click({ timeout: 15000 }).catch((e) => console.log("[s02] click 2 error:", e.message));
}

const deadline = Date.now() + 90000;
while (Date.now() < deadline && !queued) {
  const body = await page.locator("body").innerText().catch(() => "");
  if (/please wait for your last generation|switch to credits mode|insufficient credits/i.test(body)) {
    console.log("[s02] BLOCKED — Runway concurrency / credits");
    await shot("blocked");
    break;
  }
  if (/in queue|generation is in queue|generating|processing|will start/i.test(body)) {
    console.log("[s02] QUEUED");
    queued = true;
    await shot("queued");
    break;
  }
  await page.waitForTimeout(2500);
}
if (!queued) {
  console.log("[s02] timed out without queue confirmation");
  await shot("timeout");
}
console.log("[s02] holding 120s, leave the window open while the gen runs.");
await page.waitForTimeout(120000);
await ctx.close();

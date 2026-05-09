// Test the "two-click" hypothesis: on a fresh URL the first Generate click
// only creates a session shell; the second click on the resulting session
// URL is what actually queues.
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
const shot = (n) => page.screenshot({ path: resolve(outDir, `dc-${Date.now()}-${n}.png`), fullPage: true });

// Force a fresh URL without sessionId
console.log("[dc] navigating to clean tool URL");
await page.goto("https://app.runwayml.com/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);
const teamMatch = page.url().match(/\/teams\/([^/]+)\//);
const team = teamMatch ? teamMatch[1] : "laurahayes";
const cleanUrl = `https://app.runwayml.com/video-tools/teams/${team}/ai-tools/generate?tool=video&mode=tools`;
if (page.url().includes("sessionId=")) {
  console.log("[dc] redirecting to clean URL (no sessionId)");
  await page.goto(cleanUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
}
console.log("[dc] start URL:", page.url());

// Configure 9:16 + 15s
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

// Upload 3 refs
const refs = [
  resolve("projects/a-30-second-time-lapse-of-a-single-tulip-blooming-in-a-sunli/artifacts/character-tulip.png"),
  resolve("projects/a-30-second-time-lapse-of-a-single-tulip-blooming-in-a-sunli/artifacts/setting-windowsill.png"),
  resolve("projects/a-30-second-time-lapse-of-a-single-tulip-blooming-in-a-sunli/frames/01-morning-unfurl.png")
];
console.log("[dc] uploading refs");
const fileInput = page.locator("input[type='file']").first();
await fileInput.setInputFiles(refs);
const upDeadline = Date.now() + 60000;
while (Date.now() < upDeadline) {
  const body = await page.locator("body").innerText().catch(() => "");
  const matches = body.match(/\bIMG_\d+\b/g);
  const count = matches ? new Set(matches).size : 0;
  if (count >= 3 && !/started uploading|uploading\.\.\./i.test(body)) break;
  await page.waitForTimeout(1500);
}
await page.waitForTimeout(1500);

// Fill prompt
console.log("[dc] filling prompt");
const promptBox = page.locator("[role='textbox'][aria-label='Prompt'][contenteditable='true']").first();
await promptBox.click();
await page.keyboard.press("Control+A");
await page.keyboard.press("Delete");
await promptBox.fill("Cinematic 15s clip: a single red-pink tulip in a clear glass vase rests on a sunlit windowsill, soft golden morning light, locked-off macro camera. No subtitles, no captions, no visible text.");
await page.waitForTimeout(1500);

// CLICK 1
console.log("[dc] CLICK 1");
const startUrl = page.url();
const genBtn = page.getByRole("button", { name: "Generate", exact: true }).first();
await genBtn.click({ timeout: 15000 });
await page.waitForTimeout(4000);
console.log("[dc] url 4s after click 1:", page.url());
const body1 = await page.locator("body").innerText().catch(() => "");
console.log("[dc] hasInQueue after click 1?", /in queue|generation is in queue|generating/i.test(body1));
await shot("01-after-click1");

// If not queued, try CLICK 2
if (!/in queue|generation is in queue|generating/i.test(body1) && page.url().includes("sessionId=")) {
  console.log("[dc] CLICK 2 on session URL");
  await genBtn.click({ timeout: 15000 }).catch((e) => console.log("[dc] click 2 error:", e.message));
  await page.waitForTimeout(4000);
  console.log("[dc] url 4s after click 2:", page.url());
  const body2 = await page.locator("body").innerText().catch(() => "");
  console.log("[dc] hasInQueue after click 2?", /in queue|generation is in queue|generating/i.test(body2));
  await shot("02-after-click2");
  console.log("[dc] body after click 2 (first 1500 chars):", body2.slice(0, 1500));
}

console.log("[dc] holding 60s");
await page.waitForTimeout(60000);
await ctx.close();

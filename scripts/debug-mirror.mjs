// Mirror ytauto's exact runJob sequence for one segment, with screenshots
// and DOM state dumps at every step.
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

const shot = (name) => page.screenshot({ path: resolve(outDir, `mirror-${Date.now()}-${name}.png`), fullPage: true });
const dumpBtn = async (label) => {
  const btn = page.getByRole("button", { name: "Generate", exact: true }).first();
  const visible = await btn.isVisible({ timeout: 1000 }).catch(() => false);
  const enabled = await btn.isEnabled({ timeout: 1000 }).catch(() => "unknown");
  const attrs = await btn.evaluate((el) => ({
    disabled: el.hasAttribute("disabled"),
    ariaDisabled: el.getAttribute("aria-disabled"),
    dataDisabled: el.getAttribute("data-disabled"),
    pointerEvents: getComputedStyle(el).pointerEvents,
    text: el.textContent
  })).catch((err) => ({ error: err.message }));
  console.log(`[${label}] generate visible=${visible} enabled=${enabled} attrs=${JSON.stringify(attrs)}`);
};

console.log("[mirror] navigate to home");
await page.goto("https://app.runwayml.com/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
await shot("00-loaded");
await dumpBtn("00-loaded");

// ---- configure aspect 9:16
console.log("[mirror] configure aspect -> 9:16");
const aspectTrigger = page.locator("button[aria-label='Aspect ratio']").first();
console.log("[mirror] aspect current:", (await aspectTrigger.innerText().catch(() => "?")).trim());
await aspectTrigger.click({ timeout: 8000 });
await page.waitForTimeout(800);
await page.getByRole("option", { name: /^9:16$/ }).first().click({ timeout: 5000 });
await page.waitForTimeout(800);
await shot("01-after-aspect");
await dumpBtn("01-after-aspect");

// ---- configure duration 15s
console.log("[mirror] configure duration -> 15s");
const durTrigger = page.locator("button[aria-label='Duration']").first();
console.log("[mirror] duration current:", (await durTrigger.innerText().catch(() => "?")).trim());
await durTrigger.click({ timeout: 8000 });
await page.waitForTimeout(800);
await page.getByRole("option", { name: /^15\s*seconds?$/i }).first().click({ timeout: 5000 });
await page.waitForTimeout(800);
await shot("02-after-duration");
await dumpBtn("02-after-duration");

// ---- attempt resolution 1080p (we know this is disabled, expect skip)
console.log("[mirror] attempt resolution -> 1080p");
const resTrigger = page.locator("button[aria-label='Resolution']").first();
console.log("[mirror] resolution current:", (await resTrigger.innerText().catch(() => "?")).trim());
await resTrigger.click({ timeout: 8000 });
await page.waitForTimeout(800);
const opt = page.getByRole("option", { name: /^1080p$/i }).first();
const optDisabled = await opt.evaluate((el) => el.getAttribute("aria-disabled") === "true" || el.getAttribute("data-disabled") === "true").catch(() => false);
console.log("[mirror] 1080p option disabled?", optDisabled);
await page.keyboard.press("Escape");
await page.waitForTimeout(800);
await shot("03-after-resolution-skipped");
await dumpBtn("03-after-resolution-skipped");

// ---- upload 3 refs
const refs = [
  resolve("projects/a-30-second-time-lapse-of-a-single-tulip-blooming-in-a-sunli/artifacts/character-tulip.png"),
  resolve("projects/a-30-second-time-lapse-of-a-single-tulip-blooming-in-a-sunli/artifacts/setting-windowsill.png"),
  resolve("projects/a-30-second-time-lapse-of-a-single-tulip-blooming-in-a-sunli/frames/01-morning-unfurl.png")
];
console.log("[mirror] upload 3 refs and wait for IMG_3");
const fileInput = page.locator("input[type='file']").first();
await fileInput.setInputFiles(refs);
const uploadDeadline = Date.now() + 60000;
while (Date.now() < uploadDeadline) {
  const body = await page.locator("body").innerText().catch(() => "");
  const matches = body.match(/\bIMG_\d+\b/g);
  const count = matches ? new Set(matches).size : 0;
  if (count >= 3 && !/started uploading|uploading\.\.\./i.test(body)) {
    console.log("[mirror] all 3 refs visible after", Date.now() - (uploadDeadline - 60000), "ms");
    break;
  }
  await page.waitForTimeout(1500);
}
await page.waitForTimeout(1500);
await shot("04-after-uploads");
await dumpBtn("04-after-uploads");

// ---- fill prompt
console.log("[mirror] fill prompt");
const promptBox = page.locator("[role='textbox'][aria-label='Prompt'][contenteditable='true']").first();
await promptBox.click({ timeout: 10000 });
await page.keyboard.press("Control+A").catch(() => undefined);
await page.keyboard.press("Delete").catch(() => undefined);
await promptBox.fill("Cinematic 15s clip: a single red-pink tulip in a clear glass vase rests on a sunlit windowsill, soft golden morning light, locked-off macro camera. No subtitles, no captions, no visible text.");
await page.waitForTimeout(1500);
await shot("05-after-prompt");
await dumpBtn("05-after-prompt");

// ---- click Generate
console.log("[mirror] click Generate");
const startUrl = page.url();
console.log("[mirror] start URL:", startUrl);
const genBtn = page.getByRole("button", { name: "Generate", exact: true }).first();
await genBtn.click({ timeout: 15000 });
await page.waitForTimeout(2000);
await shot("06-2s-after-click");
console.log("[mirror] url 2s after click:", page.url());
await page.waitForTimeout(8000);
await shot("07-10s-after-click");
console.log("[mirror] url 10s after click:", page.url());
const body = await page.locator("body").innerText().catch(() => "");
console.log("[mirror] body after click (first 2500 chars):");
console.log(body.slice(0, 2500));

console.log("[mirror] waiting 60s before close. Don't touch the window.");
await page.waitForTimeout(60000);
await ctx.close();

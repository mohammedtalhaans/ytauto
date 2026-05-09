// Diagnose why "Generate" click navigates to a blank session without queueing.
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

const shot = (name) => page.screenshot({ path: resolve(outDir, `${Date.now()}-${name}.png`), fullPage: true });

console.log("[dbg] navigating to Runway home");
await page.goto("https://app.runwayml.com/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);
console.log("[dbg] url after home redirect:", page.url());
await shot("01-home");

console.log("[dbg] clicking Custom (if present)");
const customBtn = page.getByRole("button", { name: "Custom", exact: true }).first();
if (await customBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
  await customBtn.click();
  await page.waitForTimeout(2500);
}
console.log("[dbg] url after custom:", page.url());
await shot("02-after-custom");

const promptBox = page.locator("[role='textbox'][aria-label='Prompt'][contenteditable='true']").first();
console.log("[dbg] promptBox visible?", await promptBox.isVisible({ timeout: 2000 }).catch(() => false));

// Configure: model
const modelTrigger = page.locator("button[aria-label='Video models']").first();
console.log("[dbg] model trigger visible?", await modelTrigger.isVisible({ timeout: 2000 }).catch(() => false));
console.log("[dbg] model trigger text:", await modelTrigger.innerText().catch(() => "?"));

// Aspect
const aspectTrigger = page.locator("button[aria-label='Aspect ratio']").first();
console.log("[dbg] aspect trigger text:", await aspectTrigger.innerText().catch(() => "?"));

// Duration
const durationTrigger = page.locator("button[aria-label='Duration']").first();
console.log("[dbg] duration trigger text:", await durationTrigger.innerText().catch(() => "?"));

// Resolution
const resTrigger = page.locator("button[aria-label='Resolution']").first();
console.log("[dbg] resolution trigger text:", await resTrigger.innerText().catch(() => "?"));

// Fill prompt minimally
console.log("[dbg] filling minimal prompt");
await promptBox.click({ timeout: 10000 }).catch(() => undefined);
await page.keyboard.press("Control+A").catch(() => undefined);
await page.keyboard.press("Delete").catch(() => undefined);
await promptBox.fill("A close-up of a single red tulip in a glass vase, soft sunlight, slow gentle motion. No subtitles, no captions, no visible text.").catch(async () => {
  await page.keyboard.insertText("A close-up of a single red tulip in a glass vase, soft sunlight, slow gentle motion. No subtitles, no captions, no visible text.");
});
await page.waitForTimeout(2000);
await shot("03-after-prompt");

const genBtn = page.getByRole("button", { name: "Generate", exact: true }).first();
console.log("[dbg] generate button visible?", await genBtn.isVisible({ timeout: 2000 }).catch(() => false));
console.log("[dbg] generate button enabled?", await genBtn.isEnabled({ timeout: 2000 }).catch(() => "unknown"));
const generateAttrs = await genBtn.evaluate((el) => ({
  disabled: el.hasAttribute("disabled"),
  ariaDisabled: el.getAttribute("aria-disabled"),
  dataDisabled: el.getAttribute("data-disabled"),
  class: el.className,
  text: el.textContent
})).catch((err) => ({ error: err.message }));
console.log("[dbg] generate attrs:", JSON.stringify(generateAttrs));

console.log("[dbg] url before click:", page.url());
await shot("04-before-generate");

console.log("[dbg] clicking Generate");
await genBtn.click({ timeout: 15000 });
await page.waitForTimeout(2000);
await shot("05-just-after-click");
console.log("[dbg] url 2s after click:", page.url());

await page.waitForTimeout(8000);
await shot("06-10s-after-click");
console.log("[dbg] url 10s after click:", page.url());
const body = await page.locator("body").innerText().catch(() => "");
console.log("[dbg] body excerpt:");
console.log(body.slice(0, 2000));

console.log("[dbg] press Ctrl+C to close (or wait 60s).");
await page.waitForTimeout(60000);
await ctx.close();

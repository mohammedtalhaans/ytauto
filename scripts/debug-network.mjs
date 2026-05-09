// Capture all outbound POST requests during the click flow so we can see
// whether Runway is actually receiving a "queue" request or not.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
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

const events = [];
page.on("request", (req) => {
  const m = req.method();
  if (m !== "GET" && m !== "OPTIONS") {
    let body = "";
    try { body = req.postData() ?? ""; } catch { body = ""; }
    events.push({
      t: new Date().toISOString(),
      kind: "request",
      method: m,
      url: req.url(),
      body: body.slice(0, 1500)
    });
    console.log(`[net] ${m} ${req.url().slice(0, 120)}${body ? " body=" + body.slice(0, 300) : ""}`);
  }
});
page.on("response", async (res) => {
  const req = res.request();
  if (req.method() !== "GET" && req.method() !== "OPTIONS") {
    const status = res.status();
    let bodySnippet = "";
    try {
      const txt = await res.text();
      bodySnippet = txt.slice(0, 500);
    } catch { /* */ }
    events.push({
      t: new Date().toISOString(),
      kind: "response",
      status,
      method: req.method(),
      url: res.url(),
      body: bodySnippet
    });
    console.log(`[net] <- ${status} ${req.method()} ${res.url().slice(0, 100)}${bodySnippet ? " body=" + bodySnippet.slice(0, 300) : ""}`);
  }
});

console.log("[dbg] navigate");
await page.goto("https://app.runwayml.com/", { waitUntil: "domcontentloaded" });
await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => undefined);
await page.waitForTimeout(5000);

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

const refs = [
  resolve("projects/a-30-second-time-lapse-of-a-single-tulip-blooming-in-a-sunli/artifacts/character-tulip.png"),
  resolve("projects/a-30-second-time-lapse-of-a-single-tulip-blooming-in-a-sunli/artifacts/setting-windowsill.png"),
  resolve("projects/a-30-second-time-lapse-of-a-single-tulip-blooming-in-a-sunli/frames/01-morning-unfurl.png")
];
console.log("[dbg] uploading refs");
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

const promptBox = page.locator("[role='textbox'][aria-label='Prompt'][contenteditable='true']").first();
await promptBox.click();
await page.keyboard.press("Control+A");
await page.keyboard.press("Delete");
await promptBox.fill("Cinematic 15s clip: a single red-pink tulip in a clear glass vase rests on a sunlit windowsill. No subtitles, no captions, no visible text.");
await page.waitForTimeout(1500);

console.log("[dbg] === CLICK GENERATE ===");
console.log("[dbg] url before click:", page.url());
const before = events.length;
const genBtn = page.getByRole("button", { name: "Generate", exact: true }).first();
await genBtn.click({ timeout: 15000 });
await page.waitForTimeout(15000);
console.log("[dbg] url 15s after click:", page.url());
console.log(`[dbg] requests captured during 15s after click: ${events.length - before}`);

writeFileSync(resolve(outDir, `network-${Date.now()}.json`), JSON.stringify(events, null, 2));
console.log("[dbg] holding 30s");
await page.waitForTimeout(30000);
await ctx.close();

// Headless screenshots of every Studio view, for a visual check after a change.
//
//   BASE=http://127.0.0.1:8080 RUN_QUERY=assault_buggy bun run shot
//
// Needs a Chromium: CHROME_BIN, else /snap/bin/chromium, else Playwright's own.
import { chromium } from "playwright-core";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXEC = process.env.CHROME_BIN || (existsSync("/snap/bin/chromium") ? "/snap/bin/chromium" : undefined);
const BASE = process.env.BASE || "http://127.0.0.1:8080";
const OUT = process.env.OUT || join(HERE, "..", ".shots");
const RUN_QUERY = process.env.RUN_QUERY || "";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  ...(EXEC ? { executablePath: EXEC } : {}),
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--no-proxy-server",
    "--enable-unsafe-swiftshader",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--ignore-gpu-blocklist",
  ],
});

const page = await browser.newPage({
  viewport: { width: 1680, height: 1020 },
  deviceScaleFactor: 1.5,
  // DARK=1 captures the macOS dark appearance (the UI follows prefers-color-scheme).
  colorScheme: process.env.DARK ? "dark" : "light",
});
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(`console.error: ${m.text()}`));
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

const shot = async (name) => {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`shot: ${name}`);
};

try {
  await page.goto(BASE, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForSelector("aside", { timeout: 30000 });
  await page.waitForTimeout(800);
  await shot("01-home");

  // the composer, both presets
  await page.keyboard.press("n");
  await page.waitForTimeout(600);
  await shot("02-composer-default");
  const best = page.getByRole("button", { name: "Best quality" });
  if (await best.count()) {
    await best.click();
    await page.waitForTimeout(300);
    await shot("03-composer-best");
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  if (RUN_QUERY) {
    await page.getByPlaceholder(/filter runs|Search/).fill(RUN_QUERY);
    await page.waitForTimeout(500);
  }
  const rows = page.locator("aside ul button");
  const n = await rows.count();
  for (let i = 0; i < Math.min(n, 2); i++) {
    await rows.nth(i).click();
    await page.waitForTimeout(3500); // detail fetch + mesh load
    await shot(`run${i + 1}-model`);
    for (const label of ["Build", "Refine", "Motion", "Code"]) {
      const seg = page.getByRole("group", { name: "View" }).getByRole("button", { name: label, exact: true });
      if ((await seg.count()) && (await seg.isEnabled())) {
        await seg.click();
        await page.waitForTimeout(label === "Code" ? 2500 : 1800);
        await shot(`run${i + 1}-${label.toLowerCase()}`);
      }
    }
    if (i === 0) {
      await page.getByRole("button", { name: "Details" }).click();
      await page.waitForTimeout(900);
      await shot("run1-details");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
      await page.getByRole("button", { name: /^Download/ }).click();
      await page.waitForTimeout(500);
      await shot("run1-download");
      await page.keyboard.press("Escape");
    }
  }

  console.log("\n=== console/page errors ===");
  console.log(errors.length ? errors.join("\n") : "none");
} catch (e) {
  console.error("SCRIPT ERROR:", e.message);
  await shot("99-error");
  console.log("errors so far:", errors.join("\n") || "none");
} finally {
  await browser.close();
}

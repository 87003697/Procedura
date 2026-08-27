// Start a cheap generation through the API and screenshot the generation view
// as it runs, then the finished run. Verifies the job runner end to end.
//   BASE=http://127.0.0.1:8080 bun run scripts/shot-job.mjs
import { chromium } from "playwright-core";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXEC = process.env.CHROME_BIN || (existsSync("/snap/bin/chromium") ? "/snap/bin/chromium" : undefined);
const BASE = process.env.BASE || "http://127.0.0.1:8080";
const OUT = process.env.OUT || join(HERE, "..", ".shots");
const MAX_MIN = Number(process.env.MAX_MIN || 25);
mkdirSync(OUT, { recursive: true });

const res = await fetch(`${BASE}/api/generate`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    prompt: process.env.PROMPT || "a simple three-legged wooden stool with a round seat and a footrest ring",
    noImage: true,
    maxSteps: 1,
    preset: "custom",
  }),
});
const job = await res.json();
console.log("job:", res.status, JSON.stringify(job).slice(0, 300));
if (!res.ok) process.exit(1);

const browser = await chromium.launch({
  ...(EXEC ? { executablePath: EXEC } : {}),
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 1680, height: 1020 }, deviceScaleFactor: 1.5 });
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => m.type() === "error" && errors.push(`console.error: ${m.text()}`));

await page.goto(BASE, { waitUntil: "networkidle", timeout: 60000 });
await page.waitForSelector("aside", { timeout: 30000 });
// the job is the first row of the Generations section
await page.locator("aside ul button").first().click();
await page.waitForTimeout(1500);

const t0 = Date.now();
let n = 0;
let last = "";
for (;;) {
  const j = await (await fetch(`${BASE}/api/job?id=${job.id}`)).json();
  const tag = `${j.status} · ${j.progress?.phase} · built ${j.progress?.built}/${j.progress?.planned} · refine ${j.progress?.refineSteps}`;
  if (tag !== last) {
    console.log(`${Math.round((Date.now() - t0) / 1000)}s  ${tag}`);
    last = tag;
    await page.screenshot({ path: `${OUT}/job-${String(n++).padStart(2, "0")}-${j.progress?.phase}.png` });
  }
  if (j.status !== "running" && j.status !== "queued") {
    await page.waitForTimeout(3000);
    await page.screenshot({ path: `${OUT}/job-${String(n++).padStart(2, "0")}-final-${j.status}.png` });
    console.log("final:", j.status, j.exitCode, j.error ?? "");
    console.log("log tail:\n" + (j.log ?? []).slice(-12).join("\n"));
    break;
  }
  if (Date.now() - t0 > MAX_MIN * 60_000) {
    console.log("timeout; canceling");
    await fetch(`${BASE}/api/jobs/cancel?id=${job.id}`, { method: "POST" });
    break;
  }
  await page.waitForTimeout(15000);
}
console.log("errors:", errors.length ? errors.join("\n") : "none");
await browser.close();

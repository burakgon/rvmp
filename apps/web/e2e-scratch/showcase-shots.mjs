// Screenshot QA for /showcase.html — freezes each scene at its "money moment".
// Usage: SHOWCASE_URL=http://localhost:5666 node e2e-scratch/showcase-shots.mjs
// Needs a Playwright module: either `bun add -d @playwright/test` in the repo,
// or point PLAYWRIGHT_MODULE at any installed copy, e.g.
//   PLAYWRIGHT_MODULE=/path/to/node_modules/@playwright/test/index.mjs

import { mkdirSync } from "node:fs";

const OUT = "/tmp/rvmp-showcase-shots";
mkdirSync(OUT, { recursive: true });

const candidates = [process.env.PLAYWRIGHT_MODULE, "@playwright/test"].filter(Boolean);
let chromium;
for (const c of candidates) {
  try {
    ({ chromium } = await import(c));
    break;
  } catch {
    // try the next candidate
  }
}
if (!chromium) {
  console.error("No Playwright found. bun add -d @playwright/test, or set PLAYWRIGHT_MODULE.");
  process.exit(1);
}

// scene (1-based) → eyebrow anchor → scene-relative offset (ms) before pausing
const SHOTS = [
  { scene: 1, anchor: "00 / RVMP", at: 4000, name: "01-genesis-orbit" },
  { scene: 1, anchor: "00 / RVMP", at: 500, name: "01-genesis-enter" },
  { scene: 2, anchor: "01 / ONE BOARD", at: 1400, name: "02-fusion-flash" },
  { scene: 2, anchor: "01 / ONE BOARD", at: 6800, name: "02-one-board" },
  { scene: 3, anchor: "02 / THE BOARD", at: 3200, name: "03-board-flight-a" },
  { scene: 3, anchor: "02 / THE BOARD", at: 9500, name: "03-board-waiting" },
  { scene: 4, anchor: "03 / TERMINALS", at: 4600, name: "04-terminal-question" },
  { scene: 4, anchor: "03 / TERMINALS", at: 10000, name: "04-terminal-done" },
  { scene: 5, anchor: "04 / DETECTION", at: 4400, name: "05-detection-signals" },
  { scene: 5, anchor: "04 / DETECTION", at: 8800, name: "05-detection-flip" },
  { scene: 6, anchor: "05 / REVIEW", at: 7000, name: "06-review-comment" },
  { scene: 6, anchor: "05 / REVIEW", at: 9200, name: "06-review-queued" },
  { scene: 7, anchor: "06 / MERGE", at: 4400, name: "07-merge-menu" },
  { scene: 7, anchor: "06 / MERGE", at: 8400, name: "07-merge-landed" },
  { scene: 8, anchor: "07 / AGENTS", at: 7200, name: "08-agents" },
  { scene: 9, anchor: "08 / ANYWHERE", at: 500, name: "09-anywhere-enter" },
  { scene: 9, anchor: "08 / ANYWHERE", at: 8000, name: "09-anywhere" },
  { scene: 10, anchor: "09 / FINALE", at: 1500, name: "10-finale-converge" },
  { scene: 10, anchor: "09 / FINALE", at: 8400, name: "10-finale" },
];

const BASE = process.env.SHOWCASE_URL ?? "http://localhost:5666";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

for (const shot of SHOTS) {
  await page.goto(`${BASE}/showcase.html?scene=${shot.scene}`, {
    waitUntil: "domcontentloaded",
  });
  // Anchor on this scene's eyebrow in the transport bar, then freeze on cue.
  await page.getByText(shot.anchor, { exact: true }).first().waitFor();
  await page.waitForTimeout(shot.at);
  await page.keyboard.press("Space"); // pause → freeze-frame
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/${shot.name}.png` });
  console.log("shot", shot.name);
}

await browser.close();
console.log("done →", OUT);

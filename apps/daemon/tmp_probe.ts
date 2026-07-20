import { evaluate } from "./src/detect/manifest";
import { manifestFor } from "./src/detect/manifests";

function grid(overrides: any = {}) {
  return { rows: [], oscTitle: null, oscProgress: null, ...overrides };
}

console.log("=== Finding A: gemini explicit_yes_no_blocked misfires on agent's own prose (pros/cons list) ===");
{
  const manifest = manifestFor("gemini")!;
  const rows = [
    "Given the tradeoffs, should we proceed with the migration?",
    "1. Yes, it simplifies the build pipeline long-term.",
    "2. No, it risks breaking the release scheduled for Friday.",
    "I'll go ahead and draft the migration plan next.",
  ];
  console.log(JSON.stringify(evaluate(manifest, grid({ rows })), null, 2));
}

console.log("=== Finding A2: opencode same rule, same misfire ===");
{
  const manifest = manifestFor("opencode")!;
  const rows = [
    "Should we continue refactoring this module or leave it for later?",
    "1. Yes - continue now while context is fresh",
    "2. No - defer until the API settles",
  ];
  console.log(JSON.stringify(evaluate(manifest, grid({ rows })), null, 2));
}

console.log("=== Finding A3: aider same rule, broader keyword set (adds 'create'), same misfire ===");
{
  const manifest = manifestFor("aider")!;
  const rows = [
    "Should we create a new file for this helper?",
    "1. Yes, keep concerns separated.",
    "2. No, add it to the existing utils.py.",
    "aider> ",
  ];
  console.log(JSON.stringify(evaluate(manifest, grid({ rows })), null, 2));
}

console.log("=== Finding B: claude numbered_proceed_blocked is scoped to literal 'do you want to proceed?' only ===");
console.log("=== a differently-worded real CC permission dialog (e.g. Edit tool) misfires to idle via prompt_box_idle ===");
{
  const manifest = manifestFor("claude")!;
  const rows = [
    "╭────────────╮",
    "  ❯ ",
    "╰────────────╯",
    "Do you want to make this edit to app.ts?",
    "❯ 1. Yes",
    "  2. Yes, and don't ask again this session",
    "  3. No, tell Claude what to do differently",
  ];
  console.log(JSON.stringify(evaluate(manifest, grid({ rows })), null, 2));
}

console.log("=== Finding B2: same, but an AskUserQuestion-style select form with NO numbering at all ===");
{
  const manifest = manifestFor("claude")!;
  const rows = [
    "╭────────────╮",
    "  ❯ ",
    "╰────────────╯",
    "Which approach do you prefer?",
    "❯ Use a Map for O(1) lookups",
    "  Use a sorted array with binary search",
  ];
  console.log(JSON.stringify(evaluate(manifest, grid({ rows })), null, 2));
}

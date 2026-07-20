import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ManifestLoadError, loadManifest } from "../manifest";
import type { Manifest } from "../manifest";
import aiderToml from "./aider.toml" with { type: "text" };
import claudeToml from "./claude.toml" with { type: "text" };
import codexToml from "./codex.toml" with { type: "text" };
import geminiToml from "./gemini.toml" with { type: "text" };
import genericToml from "./generic.toml" with { type: "text" };
import opencodeToml from "./opencode.toml" with { type: "text" };

export const BUNDLED_MANIFEST_NAMES = [
  "claude",
  "codex",
  "gemini",
  "opencode",
  "aider",
  "generic",
] as const;

export type BundledManifestName = (typeof BUNDLED_MANIFEST_NAMES)[number];

export interface ManifestLookupOptions {
  /** Test/tooling seam; production uses ~/.config/codegent/agent-detection. */
  readonly overrideDir?: string;
}

const DEFAULT_OVERRIDE_DIR = join(homedir(), ".config", "codegent", "agent-detection");
const SAFE_AGENT_ID = /^[a-z0-9][a-z0-9_-]*$/;

function bundledManifest(name: BundledManifestName, toml: string): Manifest {
  try {
    return loadManifest(toml);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // Bundled manifests are trusted build inputs. Throwing while this module is
    // imported makes schema drift a startup failure instead of a silent fallback.
    throw new ManifestLoadError(`Bundled manifest ${name}.toml failed to load: ${detail}`);
  }
}

const BUNDLED_MANIFESTS: Readonly<Record<BundledManifestName, Manifest>> = Object.freeze({
  claude: bundledManifest("claude", claudeToml),
  codex: bundledManifest("codex", codexToml),
  gemini: bundledManifest("gemini", geminiToml),
  opencode: bundledManifest("opencode", opencodeToml),
  aider: bundledManifest("aider", aiderToml),
  generic: bundledManifest("generic", genericToml),
});

function localOverride(agent: string, overrideDir: string): Manifest | null {
  const path = join(overrideDir, `${agent}.toml`);
  if (!existsSync(path)) return null;

  try {
    return loadManifest(readFileSync(path, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // Herdr's local-precedence model is recorded in
    // docs/research/herdr-agent-state.md §5. A user edit must remain fail-open:
    // log it, ignore it, and retain the schema-validated bundled manifest.
    console.warn(`[detect] agent manifest override ignored (${path}): ${detail}`);
    return null;
  }
}

/**
 * Resolve a recognized agent's manifest. A valid local <agent>.toml wins;
 * unknown-but-safe agent ids use the conservative generic bundle.
 */
export function manifestFor(
  agent: string,
  options: ManifestLookupOptions = {},
): Manifest | null {
  const normalized = agent.trim().toLowerCase();
  if (!SAFE_AGENT_ID.test(normalized)) return null;

  const override = localOverride(normalized, options.overrideDir ?? DEFAULT_OVERRIDE_DIR);
  if (override) return override;

  if (Object.hasOwn(BUNDLED_MANIFESTS, normalized)) {
    return BUNDLED_MANIFESTS[normalized as BundledManifestName];
  }
  return BUNDLED_MANIFESTS.generic;
}

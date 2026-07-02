import * as os from "os";
import * as path from "path";
import * as fs from "fs";

// Resolve the Claude projects directory:
// 1. explicit config override
// 2. $CLAUDE_CONFIG_DIR/projects
// 3. ~/.claude/projects
export function resolveProjectsDir(override: string | undefined): string {
  if (override && override.trim().length > 0) {
    return expandHome(override.trim());
  }
  const cfg = process.env.CLAUDE_CONFIG_DIR;
  if (cfg && cfg.trim().length > 0) {
    return path.join(expandHome(cfg.trim()), "projects");
  }
  return path.join(os.homedir(), ".claude", "projects");
}

function expandHome(p: string): string {
  if (p === "~") {
    return os.homedir();
  }
  if (p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

// Resolve the Claude config home (~/.claude or $CLAUDE_CONFIG_DIR).
export function resolveClaudeHome(): string {
  const cfg = process.env.CLAUDE_CONFIG_DIR;
  if (cfg && cfg.trim().length > 0) {
    return expandHome(cfg.trim());
  }
  return path.join(os.homedir(), ".claude");
}

function readSettingsFile(file: string): { model?: string; effort?: string } {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8")) as { model?: unknown; effortLevel?: unknown };
    return {
      model: typeof j.model === "string" ? j.model : undefined,
      effort: typeof j.effortLevel === "string" ? j.effortLevel : undefined,
    };
  } catch {
    return {};
  }
}

// Read the currently selected model + reasoning effort, applying Claude Code
// precedence: user global (~/.claude) < project (.claude/settings.json) <
// project local (.claude/settings.local.json). Later sources override earlier.
// Both fields optional; undefined when unset across all layers.
export function readModelSettings(projectDir?: string): { model?: string; effort?: string } {
  const layers = [path.join(resolveClaudeHome(), "settings.json")];
  if (projectDir) {
    layers.push(
      path.join(projectDir, ".claude", "settings.json"),
      path.join(projectDir, ".claude", "settings.local.json"),
    );
  }
  let model: string | undefined;
  let effort: string | undefined;
  for (const file of layers) {
    const s = readSettingsFile(file);
    if (s.model !== undefined) {
      model = s.model;
    }
    if (s.effort !== undefined) {
      effort = s.effort;
    }
  }
  return { model, effort };
}

// Heuristic decode of an encoded dir name into a path. UNRELIABLE because repo
// names containing dashes are ambiguous; only used as a fallback label/path
// when no cwd was found inside the session log.
export function decodeEncodedDir(encoded: string): string {
  // Leading "-" represents the root slash; remaining dashes are path separators.
  const body = encoded.startsWith("-") ? encoded.slice(1) : encoded;
  return "/" + body.split("-").join("/");
}

export function dirExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Walk up from a directory to the nearest enclosing git repo root (the dir that
// holds a `.git` entry — a real dir for normal clones, a file for worktrees and
// submodules). Returns that root, or the input unchanged if none is found or the
// path is gone. Collapses sessions that ran in a repo SUBDIR (the agent `cd`'d
// into e.g. ./backend) back onto the repo they belong to, so a subfolder never
// spawns a phantom project group named after itself.
export function resolveRepoRoot(dir: string): string {
  let cur = dir;
  for (let i = 0; i < 40; i++) {
    try {
      if (fs.existsSync(path.join(cur, ".git"))) {
        return cur;
      }
    } catch {
      // unreadable; keep walking up
    }
    const parent = path.dirname(cur);
    if (parent === cur) {
      break; // hit filesystem root
    }
    cur = parent;
  }
  return dir;
}

#!/usr/bin/env bun
/**
 * Git worktree utilities for parallel todo processing
 *
 * Manages isolated git worktrees for ralph-todos-parallel workers.
 * Each worker operates in its own worktree to avoid branch conflicts.
 *
 * Usage:
 *   bun worktree-utils.ts create <name> <branch>  # Create worktree with branch
 *   bun worktree-utils.ts delete <name>           # Remove worktree
 *   bun worktree-utils.ts list                    # List active ralph worktrees
 *   bun worktree-utils.ts cleanup                 # Remove orphaned worktrees
 *   bun worktree-utils.ts exists <name>           # Check if worktree exists
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { access, rm } from "node:fs/promises";

const execAsync = promisify(exec);

// Resolve to repo root (4 levels up from this script)
const REPO_ROOT = join(import.meta.dir, "../../../../");
const WORKTREES_DIR = join(REPO_ROOT, ".worktrees");

interface WorktreeInfo {
  name: string;
  path: string;
  branch: string;
  commit: string;
  isRalph: boolean;
}

interface CommandResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

/**
 * Execute a shell command and return stdout
 */
async function run(command: string, cwd?: string): Promise<string> {
  const { stdout } = await execAsync(command, {
    cwd: cwd || REPO_ROOT,
    maxBuffer: 10 * 1024 * 1024, // 10MB buffer
  });
  return stdout.trim();
}

/**
 * List all git worktrees, filtering to ralph-* ones by default
 */
async function listWorktrees(all = false): Promise<WorktreeInfo[]> {
  const output = await run("git worktree list --porcelain");
  const worktrees: WorktreeInfo[] = [];

  // Parse porcelain output
  // Format: worktree <path>\nHEAD <commit>\nbranch <ref>\n\n
  const entries = output.split("\n\n").filter(Boolean);

  for (const entry of entries) {
    const lines = entry.split("\n");
    const pathLine = lines.find((l) => l.startsWith("worktree "));
    const headLine = lines.find((l) => l.startsWith("HEAD "));
    const branchLine = lines.find((l) => l.startsWith("branch "));

    if (!pathLine) continue;

    const path = pathLine.replace("worktree ", "");
    const name = path.split("/").pop() || "";
    const commit = headLine?.replace("HEAD ", "") || "";
    const branch = branchLine?.replace("branch refs/heads/", "") || "";
    const isRalph = name.startsWith("ralph-");

    if (all || isRalph) {
      worktrees.push({ name, path, branch, commit, isRalph });
    }
  }

  return worktrees;
}

/**
 * Create a new worktree for a Linear issue
 */
async function createWorktree(
  name: string,
  branch: string
): Promise<CommandResult> {
  const worktreePath = join(WORKTREES_DIR, name);

  try {
    // Check if worktree already exists
    const existing = await listWorktrees(true);
    if (existing.some((w) => w.name === name)) {
      return {
        success: false,
        error: `Worktree ${name} already exists`,
      };
    }

    // Create the worktree with a new branch from main
    // First, fetch latest main
    await run("git fetch origin main:main || true");

    // Create worktree with new branch based on main
    await run(`git worktree add "${worktreePath}" -b "${branch}" main`);

    // Install dependencies in the worktree
    await run("bun install", worktreePath);

    return {
      success: true,
      data: {
        name,
        path: worktreePath,
        branch,
        installed: true,
      },
    };
  } catch (err) {
    return {
      success: false,
      error: `Failed to create worktree: ${(err as Error).message}`,
    };
  }
}

/**
 * Delete a worktree by name
 */
async function deleteWorktree(name: string): Promise<CommandResult> {
  const worktreePath = join(WORKTREES_DIR, name);

  try {
    // Check if worktree exists
    const existing = await listWorktrees(true);
    const worktree = existing.find((w) => w.name === name);

    if (!worktree) {
      return {
        success: false,
        error: `Worktree ${name} does not exist`,
      };
    }

    // Remove the worktree (--force to handle uncommitted changes)
    await run(`git worktree remove "${worktreePath}" --force`);

    // Prune stale worktree references
    await run("git worktree prune");

    // Delete the branch if it exists and hasn't been merged
    try {
      await run(`git branch -D "${worktree.branch}" 2>/dev/null || true`);
    } catch {
      // Branch may already be deleted or merged, ignore
    }

    return {
      success: true,
      data: { name, deleted: true },
    };
  } catch (err) {
    // If git worktree remove fails, try manual cleanup
    try {
      await rm(worktreePath, { recursive: true, force: true });
      await run("git worktree prune");
      return {
        success: true,
        data: { name, deleted: true, manualCleanup: true },
      };
    } catch {
      return {
        success: false,
        error: `Failed to delete worktree: ${(err as Error).message}`,
      };
    }
  }
}

/**
 * Check if a worktree exists
 */
async function worktreeExists(name: string): Promise<CommandResult> {
  const worktreePath = join(WORKTREES_DIR, name);

  try {
    await access(worktreePath);
    const worktrees = await listWorktrees(true);
    const worktree = worktrees.find((w) => w.name === name);

    return {
      success: true,
      data: {
        exists: true,
        name,
        path: worktreePath,
        branch: worktree?.branch,
      },
    };
  } catch {
    return {
      success: true,
      data: { exists: false, name },
    };
  }
}

/**
 * Cleanup orphaned ralph-* worktrees
 * Removes worktrees that don't have a corresponding "In Progress" Linear issue
 */
async function cleanupWorktrees(): Promise<CommandResult> {
  const worktrees = await listWorktrees();
  const cleaned: string[] = [];
  const kept: string[] = [];
  const errors: string[] = [];

  for (const worktree of worktrees) {
    if (!worktree.isRalph) continue;

    // Extract Linear issue from name (ralph-HOL-123 -> HOL-123)
    const linearIssue = worktree.name.replace("ralph-", "");

    // For cleanup, we delete worktrees that are ralph-* prefixed
    // The caller should verify Linear status before calling this
    // Here we just provide the mechanism to delete

    try {
      const result = await deleteWorktree(worktree.name);
      if (result.success) {
        cleaned.push(worktree.name);
      } else {
        errors.push(`${worktree.name}: ${result.error}`);
      }
    } catch (err) {
      errors.push(`${worktree.name}: ${(err as Error).message}`);
    }
  }

  return {
    success: errors.length === 0,
    data: { cleaned, kept, errors },
  };
}

/**
 * Get the absolute path for a worktree
 */
function getWorktreePath(name: string): string {
  return join(WORKTREES_DIR, name);
}

// CLI handler
async function main() {
  const [, , command, ...args] = process.argv;

  try {
    switch (command) {
      case "create": {
        const name = args[0];
        const branch = args[1];
        if (!name || !branch) {
          console.error("Usage: worktree-utils.ts create <name> <branch>");
          process.exit(1);
        }
        const result = await createWorktree(name, branch);
        console.log(JSON.stringify(result, null, 2));
        process.exit(result.success ? 0 : 1);
        break;
      }

      case "delete": {
        const name = args[0];
        if (!name) {
          console.error("Usage: worktree-utils.ts delete <name>");
          process.exit(1);
        }
        const result = await deleteWorktree(name);
        console.log(JSON.stringify(result, null, 2));
        process.exit(result.success ? 0 : 1);
        break;
      }

      case "list": {
        const all = args.includes("--all");
        const worktrees = await listWorktrees(all);
        console.log(JSON.stringify({ worktrees }, null, 2));
        break;
      }

      case "exists": {
        const name = args[0];
        if (!name) {
          console.error("Usage: worktree-utils.ts exists <name>");
          process.exit(1);
        }
        const result = await worktreeExists(name);
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case "cleanup": {
        const result = await cleanupWorktrees();
        console.log(JSON.stringify(result, null, 2));
        process.exit(result.success ? 0 : 1);
        break;
      }

      case "path": {
        const name = args[0];
        if (!name) {
          console.error("Usage: worktree-utils.ts path <name>");
          process.exit(1);
        }
        console.log(JSON.stringify({ path: getWorktreePath(name) }));
        break;
      }

      default:
        console.log(`
Git worktree utilities for ralph-todos-parallel

Usage:
  bun worktree-utils.ts create <name> <branch>  # Create worktree with new branch
  bun worktree-utils.ts delete <name>           # Remove worktree and branch
  bun worktree-utils.ts list [--all]            # List ralph-* worktrees (or all)
  bun worktree-utils.ts exists <name>           # Check if worktree exists
  bun worktree-utils.ts cleanup                 # Remove all ralph-* worktrees
  bun worktree-utils.ts path <name>             # Get absolute path for worktree

Examples:
  bun worktree-utils.ts create ralph-HOL-123 feature/fix-auth-bug
  bun worktree-utils.ts delete ralph-HOL-123
  bun worktree-utils.ts list
`);
    }
  } catch (err) {
    console.error(JSON.stringify({ success: false, error: (err as Error).message }));
    process.exit(1);
  }
}

main();

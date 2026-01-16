#!/usr/bin/env bun
/**
 * Todo file utilities for Ralph loop skill
 *
 * Usage:
 *   bun todo-utils.ts list [status]           # List todos (optionally filter by status)
 *   bun todo-utils.ts get <file>              # Get todo details as JSON
 *   bun todo-utils.ts complete <file> [pr-url] # Mark todo as completed
 *   bun todo-utils.ts block <file> <reason>   # Mark todo as blocked
 *   bun todo-utils.ts next                    # Get next pending todo to work on
 *   bun todo-utils.ts create --priority <p1|p2|p3> --title <title> [options]  # Create new todo
 *   bun todo-utils.ts delete <file>           # Delete a todo file
 *   bun todo-utils.ts next-number             # Get next available todo number
 */

import { readdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { join, basename, dirname } from "node:path";

const TODOS_DIR = join(import.meta.dir, "../../../../todos");

interface TodoFrontmatter {
  status: "pending" | "completed" | "blocked" | "backlog";
  priority: "p1" | "p2" | "p3";
  issue_id?: string;
  linear_id?: string;
  linear_issue?: string;
  linear_url?: string;
  linear_cycle?: string;       // Cycle name (e.g., "Cycle 1")
  linear_cycle_id?: string;    // Cycle UUID for API calls
  tags?: string[];
  dependencies?: string[];
  completed_at?: string;
  completed_by?: string;
  blocked_at?: string;
  blocked_reason?: string;
  blocked_by?: string;
  pr_url?: string;
  merged_at?: string;
}

interface Todo {
  filename: string;
  filepath: string;
  frontmatter: TodoFrontmatter;
  title: string;
  content: string;
  slug: string;
  number: string;
}

interface CreateOptions {
  priority: "p1" | "p2" | "p3";
  title: string;
  description?: string;
  tags?: string[];
  parentIssue?: string;
  linearIssue?: string;
  linearUrl?: string;
  dependencies?: string[];
}

// Parse YAML frontmatter from markdown file
function parseFrontmatter(content: string): {
  frontmatter: TodoFrontmatter;
  body: string;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return {
      frontmatter: { status: "pending", priority: "p3" },
      body: content,
    };
  }

  const yamlStr = match[1];
  const body = match[2];

  // Simple YAML parser for our use case
  const frontmatter: Record<string, unknown> = {};
  for (const line of yamlStr.split("\n")) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim();
    let value: unknown = line.slice(colonIndex + 1).trim();

    // Handle arrays
    if (value === "") {
      continue;
    } else if ((value as string).startsWith("[")) {
      value = (value as string)
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""));
    } else if ((value as string).startsWith('"')) {
      value = (value as string).slice(1, -1);
    }

    frontmatter[key] = value;
  }

  return {
    frontmatter: frontmatter as unknown as TodoFrontmatter,
    body,
  };
}

// Serialize frontmatter back to YAML
function serializeFrontmatter(frontmatter: TodoFrontmatter): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map((v) => `"${v}"`).join(", ")}]`);
    } else if (typeof value === "string" && value.includes(" ")) {
      lines.push(`${key}: "${value}"`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  return lines.join("\n");
}

// Extract title from markdown content
function extractTitle(content: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : "Untitled";
}

// Parse filename to extract components
function parseFilename(filename: string): {
  number: string;
  status: string;
  priority: string;
  slug: string;
} {
  // Format: 001-pending-p1-extract-duplicate-utility-functions.md
  const match = filename.match(
    /^(\d+)-(\w+)-(p[123])-(.+)\.md$/
  );
  if (!match) {
    return { number: "000", status: "unknown", priority: "p3", slug: filename };
  }
  return {
    number: match[1],
    status: match[2],
    priority: match[3],
    slug: match[4],
  };
}

// Build new filename from components
function buildFilename(
  number: string,
  status: string,
  priority: string,
  slug: string
): string {
  return `${number}-${status}-${priority}-${slug}.md`;
}

// List all todos
async function listTodos(statusFilter?: string): Promise<Todo[]> {
  const files = await readdir(TODOS_DIR);
  const todos: Todo[] = [];

  for (const filename of files) {
    if (!filename.endsWith(".md")) continue;

    const filepath = join(TODOS_DIR, filename);
    const content = await readFile(filepath, "utf-8");
    const { frontmatter, body } = parseFrontmatter(content);
    const { number, slug } = parseFilename(filename);

    if (statusFilter && frontmatter.status !== statusFilter) continue;

    todos.push({
      filename,
      filepath,
      frontmatter,
      title: extractTitle(body),
      content: body,
      slug,
      number,
    });
  }

  // Sort by cycle (current > next > none), then priority (p1 first), then number
  const priorityOrder = { p1: 1, p2: 2, p3: 3 };
  const cycleOrder = (cycle: string | undefined): number => {
    if (!cycle) return 3; // No cycle = backlog (lowest priority)
    if (cycle.toLowerCase().includes("current")) return 1;
    return 2; // Next or other cycle
  };

  todos.sort((a, b) => {
    // First: sort by cycle
    const cycleDiff =
      cycleOrder(a.frontmatter.linear_cycle) -
      cycleOrder(b.frontmatter.linear_cycle);
    if (cycleDiff !== 0) return cycleDiff;

    // Then: sort by priority within cycle
    const priorityDiff =
      priorityOrder[a.frontmatter.priority] -
      priorityOrder[b.frontmatter.priority];
    if (priorityDiff !== 0) return priorityDiff;

    // Finally: sort by number
    return parseInt(a.number) - parseInt(b.number);
  });

  return todos;
}

// Get next pending todo (respecting dependencies)
async function getNextTodo(): Promise<Todo | null> {
  const todos = await listTodos("pending");
  const completedIds = new Set(
    (await listTodos("completed")).map((t) => t.frontmatter.issue_id).filter(Boolean)
  );

  for (const todo of todos) {
    // Check dependencies (filter out empty strings)
    const deps = (todo.frontmatter.dependencies || []).filter((d) => d && d.trim() !== "");
    const unmetDeps = deps.filter((dep) => !completedIds.has(dep));

    if (unmetDeps.length === 0) {
      return todo;
    }
  }

  return null;
}

// Mark todo as completed
async function completeTodo(filename: string, prUrl?: string): Promise<void> {
  const filepath = join(TODOS_DIR, filename);
  const content = await readFile(filepath, "utf-8");
  const { frontmatter, body } = parseFrontmatter(content);
  const { number, priority, slug } = parseFilename(filename);

  // Update frontmatter
  frontmatter.status = "completed";
  frontmatter.completed_at = new Date().toISOString();
  if (prUrl) {
    frontmatter.pr_url = prUrl;
  }

  // Build new content
  const newContent = `---\n${serializeFrontmatter(frontmatter)}\n---\n${body}`;

  // Build new filename
  const newFilename = buildFilename(number, "completed", priority, slug);
  const newFilepath = join(TODOS_DIR, newFilename);

  // Write updated content and rename
  await writeFile(filepath, newContent);
  if (filename !== newFilename) {
    await rename(filepath, newFilepath);
  }

  console.log(JSON.stringify({ success: true, newFilename, prUrl }));
}

// Mark todo as blocked
async function blockTodo(filename: string, reason: string): Promise<void> {
  const filepath = join(TODOS_DIR, filename);
  const content = await readFile(filepath, "utf-8");
  const { frontmatter, body } = parseFrontmatter(content);
  const { number, priority, slug } = parseFilename(filename);

  // Update frontmatter
  frontmatter.status = "blocked";
  frontmatter.blocked_at = new Date().toISOString();
  frontmatter.blocked_reason = reason;

  // Build new content
  const newContent = `---\n${serializeFrontmatter(frontmatter)}\n---\n${body}`;

  // Build new filename
  const newFilename = buildFilename(number, "blocked", priority, slug);
  const newFilepath = join(TODOS_DIR, newFilename);

  // Write updated content and rename
  await writeFile(filepath, newContent);
  if (filename !== newFilename) {
    await rename(filepath, newFilepath);
  }

  console.log(JSON.stringify({ success: true, newFilename, reason }));
}

// Get the next available todo number
async function getNextNumber(): Promise<string> {
  const files = await readdir(TODOS_DIR);
  let maxNumber = 0;

  for (const filename of files) {
    if (!filename.endsWith(".md")) continue;
    const { number } = parseFilename(filename);
    const num = parseInt(number);
    if (num > maxNumber) {
      maxNumber = num;
    }
  }

  return String(maxNumber + 1).padStart(3, "0");
}

// Create a new todo file
async function createTodo(options: CreateOptions): Promise<void> {
  const number = await getNextNumber();

  // Generate slug from title
  const slug = options.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);

  const filename = buildFilename(number, "pending", options.priority, slug);
  const filepath = join(TODOS_DIR, filename);

  // Build frontmatter
  const frontmatter: TodoFrontmatter = {
    status: "pending",
    priority: options.priority,
    issue_id: number,
    tags: options.tags || [],
  };

  if (options.linearIssue) {
    (frontmatter as Record<string, unknown>).linear_issue = options.linearIssue;
  }
  if (options.linearUrl) {
    (frontmatter as Record<string, unknown>).linear_url = options.linearUrl;
  }
  if (options.dependencies?.length) {
    frontmatter.dependencies = options.dependencies;
  }

  // Build content
  const body = `
# ${options.title}

## Problem Statement

${options.description || "[To be defined]"}

${options.parentIssue ? `## Origin\n\nCreated as follow-up from todo ${options.parentIssue} during code review.\n` : ""}
## Acceptance Criteria

- [ ] [Define acceptance criteria]

## Notes

[Add implementation notes here]
`;

  const content = `---\n${serializeFrontmatter(frontmatter)}\n---\n${body}`;
  await writeFile(filepath, content);

  console.log(
    JSON.stringify({
      success: true,
      filename,
      filepath,
      number,
      linear_issue: options.linearIssue || null,
    })
  );
}

// Delete a todo file
async function deleteTodo(filename: string): Promise<void> {
  const filepath = join(TODOS_DIR, filename);

  try {
    await unlink(filepath);
    console.log(JSON.stringify({ success: true, deleted: filename }));
  } catch (err) {
    console.log(
      JSON.stringify({ success: false, error: (err as Error).message })
    );
    process.exit(1);
  }
}

// Find local todo by Linear issue identifier
async function findByLinearIssue(linearIssue: string): Promise<Todo | null> {
  const todos = await listTodos();
  for (const todo of todos) {
    const fm = todo.frontmatter as Record<string, unknown>;
    if (fm.linear_issue === linearIssue) {
      return todo;
    }
  }
  return null;
}

// List all Linear issue identifiers in local todos
async function listLinearIssues(): Promise<string[]> {
  const todos = await listTodos();
  const issues: string[] = [];
  for (const todo of todos) {
    const fm = todo.frontmatter as Record<string, unknown>;
    if (fm.linear_issue) {
      issues.push(fm.linear_issue as string);
    }
  }
  return issues;
}

// Update a todo's frontmatter with Linear data
async function updateFromLinear(
  filename: string,
  linearIssue: string,
  linearUrl: string,
  newTitle?: string
): Promise<void> {
  const filepath = join(TODOS_DIR, filename);
  const content = await readFile(filepath, "utf-8");
  const { frontmatter, body } = parseFrontmatter(content);

  // Update frontmatter
  (frontmatter as Record<string, unknown>).linear_issue = linearIssue;
  (frontmatter as Record<string, unknown>).linear_url = linearUrl;

  // Optionally update title in body
  let newBody = body;
  if (newTitle) {
    newBody = body.replace(/^#\s+.+$/m, `# ${newTitle}`);
  }

  const newContent = `---\n${serializeFrontmatter(frontmatter)}\n---\n${newBody}`;
  await writeFile(filepath, newContent);

  console.log(
    JSON.stringify({
      success: true,
      filename,
      linear_issue: linearIssue,
      linear_url: linearUrl,
      title_updated: !!newTitle,
    })
  );
}

// Parse CLI arguments for create command
function parseCreateArgs(args: string[]): CreateOptions {
  const options: Partial<CreateOptions> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    switch (arg) {
      case "--priority":
        if (["p1", "p2", "p3"].includes(nextArg)) {
          options.priority = nextArg as "p1" | "p2" | "p3";
        }
        i++;
        break;
      case "--title":
        options.title = nextArg;
        i++;
        break;
      case "--description":
        options.description = nextArg;
        i++;
        break;
      case "--tags":
        options.tags = nextArg.split(",").map((t) => t.trim());
        i++;
        break;
      case "--parent-issue":
        options.parentIssue = nextArg;
        i++;
        break;
      case "--linear-issue":
        options.linearIssue = nextArg;
        i++;
        break;
      case "--linear-url":
        options.linearUrl = nextArg;
        i++;
        break;
      case "--dependencies":
        options.dependencies = nextArg.split(",").map((d) => d.trim());
        i++;
        break;
    }
  }

  if (!options.priority || !options.title) {
    console.error("Usage: todo-utils.ts create --priority <p1|p2|p3> --title <title> [options]");
    console.error("Options:");
    console.error("  --description <text>    Problem statement");
    console.error("  --tags <tag1,tag2>      Comma-separated tags");
    console.error("  --parent-issue <id>     Parent todo issue_id");
    console.error("  --linear-issue <HOL-X>  Linear issue identifier");
    console.error("  --linear-url <url>      Full Linear URL");
    console.error("  --dependencies <id1,id2> Comma-separated dependency IDs");
    process.exit(1);
  }

  return options as CreateOptions;
}

// CLI handler
async function main() {
  const [, , command, ...args] = process.argv;

  switch (command) {
    case "list": {
      const status = args[0]; // optional status filter
      const todos = await listTodos(status);
      console.log(JSON.stringify(todos, null, 2));
      break;
    }

    case "get": {
      const filename = args[0];
      if (!filename) {
        console.error("Usage: todo-utils.ts get <filename>");
        process.exit(1);
      }
      const filepath = join(TODOS_DIR, filename);
      const content = await readFile(filepath, "utf-8");
      const { frontmatter, body } = parseFrontmatter(content);
      const { number, slug } = parseFilename(filename);
      console.log(
        JSON.stringify(
          {
            filename,
            filepath,
            frontmatter,
            title: extractTitle(body),
            slug,
            number,
          },
          null,
          2
        )
      );
      break;
    }

    case "next": {
      const todo = await getNextTodo();
      if (todo) {
        console.log(JSON.stringify(todo, null, 2));
      } else {
        console.log(JSON.stringify({ none: true, message: "No pending todos with met dependencies" }));
      }
      break;
    }

    case "complete": {
      const filename = args[0];
      const prUrl = args[1];
      if (!filename) {
        console.error("Usage: todo-utils.ts complete <filename> [pr-url]");
        process.exit(1);
      }
      await completeTodo(filename, prUrl);
      break;
    }

    case "block": {
      const filename = args[0];
      const reason = args.slice(1).join(" ");
      if (!filename || !reason) {
        console.error("Usage: todo-utils.ts block <filename> <reason>");
        process.exit(1);
      }
      await blockTodo(filename, reason);
      break;
    }

    case "create": {
      const options = parseCreateArgs(args);
      await createTodo(options);
      break;
    }

    case "delete": {
      const filename = args[0];
      if (!filename) {
        console.error("Usage: todo-utils.ts delete <filename>");
        process.exit(1);
      }
      await deleteTodo(filename);
      break;
    }

    case "next-number": {
      const number = await getNextNumber();
      console.log(JSON.stringify({ nextNumber: number }));
      break;
    }

    case "find-by-linear": {
      const linearIssue = args[0];
      if (!linearIssue) {
        console.error("Usage: todo-utils.ts find-by-linear <HOL-XXX>");
        process.exit(1);
      }
      const todo = await findByLinearIssue(linearIssue);
      if (todo) {
        console.log(JSON.stringify(todo, null, 2));
      } else {
        console.log(JSON.stringify({ found: false, linearIssue }));
      }
      break;
    }

    case "list-linear-issues": {
      const issues = await listLinearIssues();
      console.log(JSON.stringify({ issues, count: issues.length }));
      break;
    }

    case "update-from-linear": {
      const filename = args[0];
      const linearIssue = args[1];
      const linearUrl = args[2];
      const newTitle = args[3];
      if (!filename || !linearIssue || !linearUrl) {
        console.error(
          "Usage: todo-utils.ts update-from-linear <filename> <HOL-XXX> <url> [new-title]"
        );
        process.exit(1);
      }
      await updateFromLinear(filename, linearIssue, linearUrl, newTitle);
      break;
    }

    default:
      console.log(`
Todo file utilities for Ralph loop skill

Usage:
  bun todo-utils.ts list [status]           # List todos (optionally filter by status)
  bun todo-utils.ts get <file>              # Get todo details as JSON
  bun todo-utils.ts complete <file> [pr-url] # Mark todo as completed
  bun todo-utils.ts block <file> <reason>   # Mark todo as blocked
  bun todo-utils.ts next                    # Get next pending todo to work on
  bun todo-utils.ts create --priority <p1|p2|p3> --title <title> [options]
                                            # Create new todo file
  bun todo-utils.ts delete <file>           # Delete a todo file
  bun todo-utils.ts next-number             # Get next available todo number

Linear sync commands:
  bun todo-utils.ts find-by-linear <HOL-X>  # Find local todo by Linear issue
  bun todo-utils.ts list-linear-issues      # List all Linear issues in local todos
  bun todo-utils.ts update-from-linear <file> <HOL-X> <url> [new-title]
                                            # Update todo with Linear data

Create options:
  --description <text>    Problem statement
  --tags <tag1,tag2>      Comma-separated tags
  --parent-issue <id>     Parent todo issue_id
  --linear-issue <HOL-X>  Linear issue identifier
  --linear-url <url>      Full Linear URL
  --dependencies <id1,id2> Comma-separated dependency IDs
`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

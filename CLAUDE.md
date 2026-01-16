# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This repository contains shared Claude Code plugins for the HolyMolarLabs polyrepo. The main plugin is **ralph-todos**, an autonomous todo processing system with Linear integration.

## Repository Structure

```
ralph-todos/
├── .claude-plugin/plugin.json    # Plugin metadata
├── schema/ralph.schema.toml      # Configuration schema documentation
├── commands/                     # Slash command definitions
│   ├── ralph-todos.md           # Sequential processing command
│   └── ralph-todos-parallel.md  # Parallel processing command
├── skills/                       # Skill implementations
│   ├── ralph-todos/SKILL.template.md      # Main skill (templated)
│   ├── ralph-todos-parallel/SKILL.md      # Parallel orchestrator
│   └── ralph-todos-worker/SKILL.md        # Worker for parallel execution
└── scripts/                      # TypeScript utilities
    ├── todo-utils.ts             # Todo file CRUD operations
    └── worktree-utils.ts         # Git worktree management
```

## Key Commands

```bash
# Run utility scripts (uses bun)
bun ralph-todos/scripts/todo-utils.ts <command>
bun ralph-todos/scripts/worktree-utils.ts <command>

# Sync plugin to a target repo
bin/sync-ralph-plugin ../path/to/repo
bin/sync-ralph-plugin --all
```

## Architecture

### Linear as Source of Truth

Linear is the single source of truth for all work items. Local todo files in the target repo's `todos/` directory are temporary working documents that:
- Are created when syncing from Linear
- Provide implementation context during work
- Are deleted after PR merge (Linear is the permanent record)

### Workflow Sequence

Every task follows: **Plan → Work → Review → Compound**

1. `/workflows:plan` - Design implementation approach
2. `/workflows:work` - Execute plan, write code
3. `/workflows:review` - Multi-agent code review
4. `/workflows:compound` - Document learnings

### Parallel Processing

The parallel skill uses:
- **Git worktrees** for isolation (`.worktrees/ralph-HOL-xxx/`)
- **Linear status as distributed lock** - "In Progress" status prevents concurrent claims
- **Workers launched in parallel** via multiple Task tool calls in a single message

### Todo File Format

```yaml
---
status: pending|completed|blocked
priority: p1|p2|p3
issue_id: "001"
linear_issue: "HOL-123"
linear_url: "https://..."
tags: [tag1, tag2]
dependencies: ["other-issue-id"]
---

# Todo Title

## Problem Statement
...

## Acceptance Criteria
- [ ] Criterion 1
```

Filename format: `{number}-{status}-{priority}-{slug}.md`
Example: `001-pending-p1-extract-duplicate-utility-functions.md`

## Template Variables

SKILL.template.md uses placeholders replaced during sync:

| Variable | Source |
|----------|--------|
| `{{project.name}}` | `ralph.toml` → `[project] name` |
| `{{project.label}}` | `ralph.toml` → `[project] label` |
| `{{linear.team}}` | `ralph.toml` → `[linear] team` |
| `{{linear.followup_labels}}` | JSON array from config |
| `{{linear.followup_labels_csv}}` | Comma-separated version |
| `{{linear.backlog_labels}}` | JSON array from config |
| `{{paths.todos_dir}}` | `ralph.toml` → `[paths] todos_dir` |
| `{{tools.package_manager}}` | `ralph.toml` → `[tools] package_manager` |

## Linear MCP Integration

Linear access is via MCP tools, not CLI:
- `mcp__linear__list_teams()` - Verify connection
- `mcp__linear__list_issues(...)` - Fetch issues
- `mcp__linear__get_issue(...)` - Get issue details
- `mcp__linear__update_issue(...)` - Update status
- `mcp__linear__create_issue(...)` - Create new issues
- `mcp__linear__create_comment(...)` - Add comments
- `mcp__linear__list_cycles(...)` - Get sprint cycles

## Development

When updating the plugin:
1. Edit files in `ralph-todos/`
2. For templated files, edit `SKILL.template.md` (not the generated `SKILL.md`)
3. Test sync: `bin/sync-ralph-plugin ../target/repo`
4. Test skill: `/ralph-todos --dry-run`

## Critical Constraints

- Never commit todo files in feature PRs (they're ephemeral)
- P1 review findings block completion; P2/P3 create follow-up Linear tickets
- Always wait for CI before merging (`gh pr checks --watch`)
- Workers must be launched in parallel (single message with multiple Task calls)
- Linear status "In Progress" is the distributed lock for parallel processing

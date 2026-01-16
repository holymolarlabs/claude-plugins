---
name: ralph-todos-parallel
description: Process multiple todos in parallel using isolated git worktrees.
argument-hint: "[--workers N] [--max-todos N] [--skip-review] [--no-merge] [--dry-run]"
---

# Ralph Todos Parallel

You are now running the Ralph Todos Parallel orchestrator. Follow the SKILL.md instructions at `.claude/skills/ralph-todos-parallel/SKILL.md`.

## Arguments Received

$ARGUMENTS

## Your Task

Execute the parallel processing loop as described in the skill file:

1. **Parse arguments**: Extract --workers, --max-todos, --skip-review, --no-merge, --dry-run flags
2. **Sync**: Fetch issues from Linear, create/update local todos
3. **Build queue**: Sort pending todos by cycle and priority
4. **Clarify**: Ask ALL clarifying questions upfront for all todos
5. **Process batches**: For each batch of N todos:
   - Claim via Linear (update to "In Progress")
   - Create worktrees
   - Launch N workers in parallel (SINGLE MESSAGE with multiple Task calls)
   - Collect results
   - Update Linear, cleanup completed worktrees
6. **Report**: Generate summary with completed, blocked, failed counts

## Helper Scripts

```bash
# Worktree management
bun .claude/skills/ralph-todos-parallel/scripts/worktree-utils.ts create ralph-HOL-123 feature/fix-bug
bun .claude/skills/ralph-todos-parallel/scripts/worktree-utils.ts delete ralph-HOL-123
bun .claude/skills/ralph-todos-parallel/scripts/worktree-utils.ts list

# Todo utilities (from ralph-todos)
bun .claude/skills/ralph-todos/scripts/todo-utils.ts list pending
bun .claude/skills/ralph-todos/scripts/todo-utils.ts next
```

## Critical Reminders

- **Parallel Task calls**: Launch all workers in a SINGLE message
- **Linear is the lock**: Only claim todos with status "Todo"
- **Worktree isolation**: Each worker operates in its own `.worktrees/ralph-*` directory
- **Cleanup**: Remove worktrees after successful merge

## Default Values

- Workers: 3
- Max todos: unlimited
- Skip review: false
- No merge: false
- Dry run: false

Begin by parsing arguments and syncing from Linear.

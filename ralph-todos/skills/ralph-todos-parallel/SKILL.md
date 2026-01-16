---
name: ralph-todos-parallel
description: Orchestrates N parallel workers to process todos concurrently using isolated git worktrees. Uses Linear "In Progress" status as distributed lock.
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  - Task
  - Skill
  - TodoWrite
  - AskUserQuestion
  - mcp__linear__*
---

# Ralph Todos Parallel

Orchestrates multiple workers processing todos concurrently in isolated git worktrees.

## Quick Start

```bash
/ralph-todos-parallel                    # Process with 3 workers (default)
/ralph-todos-parallel --workers 5        # Use 5 parallel workers
/ralph-todos-parallel --max-todos 10     # Stop after 10 todos total
/ralph-todos-parallel --skip-review      # Skip review phase in workers
/ralph-todos-parallel --no-merge         # Create PRs but don't auto-merge
/ralph-todos-parallel --dry-run          # Show what would be processed
/ralph-todos-parallel --sync             # Force sync from Linear first
```

## Prerequisites

Same as ralph-todos: Linear MCP integration must be working.
Verify with: `mcp__linear__list_teams()`

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   Orchestrator (this skill)             │
│                                                         │
│  1. Sync from Linear                                    │
│  2. Build work queue                                    │
│  3. Upfront clarification                               │
│  4. For each batch of N todos:                          │
│     a. Claim todos (Linear → In Progress)               │
│     b. Create worktrees                                 │
│     c. Launch N workers (single message, parallel)      │
│     d. Collect results                                  │
│     e. Update Linear, cleanup                           │
│  5. Generate summary report                             │
└─────────────────────────────────────────────────────────┘
                           │
          ┌────────────────┼────────────────┐
          ▼                ▼                ▼
    ┌──────────┐    ┌──────────┐    ┌──────────┐
    │ Worker 1 │    │ Worker 2 │    │ Worker N │
    │ worktree │    │ worktree │    │ worktree │
    └──────────┘    └──────────┘    └──────────┘
```

## Alternative: Worktrunk

For a more polished worktree experience, consider [worktrunk.dev](https://worktrunk.dev/) - a CLI tool designed specifically for parallel AI agent workflows with worktrees.

## Main Workflow

### Phase 0: Parse Arguments

```
--workers N       : Number of parallel workers (default: 3, max: 5)
--max-todos N     : Stop after N todos processed (default: unlimited)
--skip-review     : Pass to workers to skip review phase
--skip-compound   : Pass to workers to skip compound phase
--no-merge        : Pass to workers to skip auto-merge
--dry-run         : Show queue without processing
--sync            : Force sync from Linear before starting
--include-backlog : Include backlog items (default: current+next cycle only)
```

### Phase 1: Sync from Linear (Source of Truth)

Same as ralph-todos Phase 0.5:

1. **Get cycles:**
   ```
   mcp__linear__list_cycles(teamId: "HolyMolarLabs", type: "current")
   mcp__linear__list_cycles(teamId: "HolyMolarLabs", type: "next")
   ```

2. **Fetch issues:**
   ```
   mcp__linear__list_issues(
     team: "HolyMolarLabs",
     cycle: "[current-cycle-id]",
     state: ["Todo", "In Progress"],
     label: "web"
   )
   ```

3. **Create/update local todos** for any Linear issues without matching local files

### Phase 2: Build Work Queue

1. Read all `todos/*-pending-*.md` files
2. Filter to those with `linear_issue` in frontmatter
3. Sort by: cycle (current→next→backlog) → priority (p1→p2→p3) → number
4. Apply `--max-todos` limit if set

If `--dry-run`, output queue and stop:
```markdown
## Dry Run - Work Queue

| # | Linear | Priority | Cycle | Title |
|---|--------|----------|-------|-------|
| 1 | HOL-123 | P1 | Current | Fix auth bug |
| 2 | HOL-124 | P2 | Current | Add validation |
| 3 | HOL-125 | P2 | Next | Refactor API |

Would process 3 todos with 3 workers.
```

### Phase 3: Upfront Clarification

Same as ralph-todos Phase 0.7 - review all todos and ask ALL clarifying questions at once using AskUserQuestion before starting any work.

### Phase 4: Process Batches

For each batch of N todos (where N = --workers):

#### 4a. Claim Todos via Linear

For each todo in batch:

```
# Check current state
issue = mcp__linear__get_issue(id: "[linearId]")

# Only claim if status is "Todo" or "Backlog"
if issue.state.name in ["Todo", "Backlog"]:
    mcp__linear__update_issue(
        id: "[linearId]",
        state: "In Progress"
    )
    mcp__linear__create_comment(
        issueId: "[linearId]",
        body: "Claimed by parallel worker for processing."
    )
else:
    # Already claimed by another process, skip this todo
    skip and find replacement from queue
```

**Important:** This is the distributed lock. If Linear is already "In Progress", another worker or orchestrator has claimed it.

#### 4b. Create Worktrees

For each claimed todo, create isolated worktree:

```bash
bun .claude/skills/ralph-todos-parallel/scripts/worktree-utils.ts create \
    "ralph-[linearIssue]" \
    "feature/[slug]"
```

This creates:
- `.worktrees/ralph-HOL-123/` directory
- New branch `feature/[slug]` from main
- Runs `bun install` in the worktree

#### 4c. Launch Workers in Parallel

**CRITICAL: All workers MUST be launched in a SINGLE MESSAGE with multiple Task tool calls.**

```
Task ralph-todos-worker
  subagent_type: ralph-todos-worker
  Prompt: "Process todo with:
    worktreePath: [absolute path to .worktrees/ralph-HOL-123]
    todoFile: [path to todo file]
    linearId: [Linear UUID]
    linearIssue: HOL-123
    skipReview: [from args]
    skipCompound: [from args]
    noMerge: [from args]"

Task ralph-todos-worker
  subagent_type: ralph-todos-worker
  Prompt: "Process todo with:
    worktreePath: [absolute path to .worktrees/ralph-HOL-124]
    todoFile: [path to todo file]
    linearId: [Linear UUID]
    linearIssue: HOL-124
    ..."

Task ralph-todos-worker
  subagent_type: ralph-todos-worker
  Prompt: "Process todo with:
    worktreePath: [absolute path to .worktrees/ralph-HOL-125]
    ..."
```

**DO NOT launch workers sequentially.** Parallel execution is the whole point.

#### 4d. Collect Results

Each worker returns a structured result in `<worker-result>` tags. Parse each:

```json
{
  "status": "completed" | "blocked" | "failed",
  "linearId": "...",
  "linearIssue": "HOL-123",
  "prUrl": "https://...",
  "prNumber": 45,
  "merged": true,
  "error": null,
  "followUps": ["HOL-124"]
}
```

#### 4e. Update State Based on Results

For each result:

| Status | Actions |
|--------|---------|
| `completed` + merged | Update Linear to "Done", delete local todo, remove worktree |
| `completed` + not merged | Keep Linear "In Progress", keep worktree (PR open) |
| `blocked` | Update Linear to "Blocked" with reason, keep worktree |
| `failed` | Revert Linear to "Todo", keep worktree for debugging |

**Update Linear on completion:**
```
mcp__linear__update_issue(
    id: "[linearId]",
    state: "Done",
    cycle: "[current-cycle-id]"  # Assign to current cycle
)

mcp__linear__create_comment(
    issueId: "[linearId]",
    body: "Completed by Claude parallel worker.\n\nPR: [prUrl]\nMerged: [timestamp]"
)
```

**Delete local todo (Linear is source of truth):**
```bash
rm todos/[todo-filename]
```

**Remove worktree:**
```bash
bun .claude/skills/ralph-todos-parallel/scripts/worktree-utils.ts delete "ralph-[linearIssue]"
```

### Phase 5: Continue or Stop

Check:
1. If `--max-todos` reached → Stop
2. If no more pending todos in queue → Stop
3. Otherwise → Go to Phase 4 with next batch

### Phase 6: Final Cleanup

```bash
# Prune any orphaned worktree references
git worktree prune

# List remaining worktrees (for debugging blocked/failed)
bun .claude/skills/ralph-todos-parallel/scripts/worktree-utils.ts list
```

### Phase 7: Generate Summary Report

```markdown
## Ralph Parallel Summary

**Workers Used:** 3
**Batches Processed:** 2
**Total Todos:** 6
**Completed:** 5 (merged: 4, open: 1)
**Blocked:** 1
**Failed:** 0

### Completed & Merged
| Linear | PR | Title |
|--------|-----|-------|
| HOL-123 | [#45](url) | Fix auth bug |
| HOL-124 | [#46](url) | Add validation |

### Open PRs (awaiting merge)
| Linear | PR | Title |
|--------|-----|-------|
| HOL-127 | [#49](url) | Update docs |

### Blocked
| Linear | Reason | Worktree |
|--------|--------|----------|
| HOL-125 | P1: SQL injection | `.worktrees/ralph-HOL-125` |

### Failed
(none)

### Follow-up Issues Created
- HOL-128: Refactor validation logic (P2)
- HOL-129: Add integration tests (P3)

### Worktrees
- **Cleaned:** ralph-HOL-123, ralph-HOL-124, ralph-HOL-126, ralph-HOL-127
- **Retained:** ralph-HOL-125 (blocked - for debugging)

### Next Steps
1. Review blocked worktree at `.worktrees/ralph-HOL-125`
2. Merge open PR #49
3. Run `/ralph-todos-parallel` again for remaining items
```

Output completion signal:
```
<promise>RALPH_TODOS_PARALLEL_COMPLETE</promise>
```

## Parallelism Constraints

| Constraint | Limit | Reason |
|------------|-------|--------|
| Max workers | 5 | Disk space, API rate limits |
| Worktree size | ~100MB each | node_modules per worktree |
| CI concurrency | Depends on GitHub plan | May queue if too many PRs |

## Race Condition Prevention

Linear status is the distributed lock:

1. **Check before claim:** `mcp__linear__get_issue()`
2. **Only claim "Todo":** Skip if already "In Progress"
3. **Atomic update:** Linear API handles concurrent writes

If two orchestrators race:
- Both check → both see "Todo"
- Both update → only one succeeds (Linear serializes)
- Loser's subsequent `get_issue()` sees "In Progress" → skips

## Error Handling

| Error | Recovery |
|-------|----------|
| Worktree creation fails | Release Linear claim, skip todo |
| Worker times out | Mark as failed, keep worktree |
| All workers fail in batch | Stop, report errors, suggest `--workers 1` |
| Disk space low | Fail fast before creating worktrees |

## Integration with ralph-todos

This skill complements the original `ralph-todos`:

| Scenario | Use |
|----------|-----|
| Few todos, sequential focus | `ralph-todos` |
| Many todos, speed priority | `ralph-todos-parallel` |
| Debugging a specific issue | `ralph-todos --max-iterations 1` |
| Bulk processing | `ralph-todos-parallel --workers 5` |

Both share:
- Same todo file format
- Same Linear integration
- Same workflow phases (Plan→Work→Review→Compound)
- Same cleanup behavior (delete todos after merge)

## Troubleshooting

**"Worktree already exists"**
- Another run may have created it
- Use `bun worktree-utils.ts list` to check
- Clean with `bun worktree-utils.ts delete ralph-HOL-XXX`

**"Linear issue already In Progress"**
- Another worker/orchestrator claimed it
- Check who: `mcp__linear__get_issue()` → see comments
- Wait for other process or manually reset status

**"Workers not running in parallel"**
- Ensure all Task calls are in a SINGLE message
- Check you're using `subagent_type: ralph-todos-worker`

**"Disk space issues"**
- Each worktree needs ~100-200MB for node_modules
- Clean old worktrees: `bun worktree-utils.ts cleanup`
- Reduce `--workers` count

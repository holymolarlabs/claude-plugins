---
name: ralph-todos
description: Autonomous todo processing loop using Ralph Wiggum technique. Picks todos from todos/ folder (P1 first), runs Plan → Work → Review → Compound workflow, opens PRs, marks complete/blocked. Use when you want Claude to autonomously work through pending todos. Triggers on "work through todos", "ralph loop", "process todos autonomously".
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

# Ralph Todos: Autonomous Todo Processing Loop

## Quick Start

```bash
/ralph-todos                           # Process current + next cycle todos
/ralph-todos --max-iterations 5        # Stop after 5 todos
/ralph-todos --include-backlog         # Also process backlog items
/ralph-todos --skip-review             # Skip review step (faster)
/ralph-todos --no-merge                # Open PRs but don't auto-merge
/ralph-todos --keep-todos              # Keep completed todo files (default: delete)
/ralph-todos --sync                    # Sync Linear → local todos before starting
```

## Prerequisites: Linear MCP Integration

**Linear access is via MCP tools, NOT CLI binaries.**

To interact with Linear, use the `mcp__linear__*` function calls directly:
- `mcp__linear__list_teams()` - Verify connection
- `mcp__linear__list_issues(...)` - Fetch issues
- `mcp__linear__get_issue(...)` - Get issue details
- `mcp__linear__update_issue(...)` - Update status
- `mcp__linear__create_issue(...)` - Create new issues
- `mcp__linear__create_comment(...)` - Add comments
- `mcp__linear__list_cycles(...)` - Get sprint cycles

**DO NOT** check for CLI binaries like `which linear` or shell commands. The Linear MCP server provides these tools as function calls available in your tool list. Just call them directly.

**Quick verification:** Call `mcp__linear__list_teams()` - if it returns team data, Linear is working.

### Linear Context Efficiency (CRITICAL)

**Problem:** Linear MCP responses can consume 10k+ tokens per call, rapidly filling context.

**Rules:**

1. **Always use `limit` parameter:**
   ```
   mcp__linear__list_issues(team: "...", limit: 10)  # ✅ Good
   mcp__linear__list_issues(team: "...")             # ❌ Bad - fetches 50 by default
   ```

2. **Filter aggressively:**
   ```
   mcp__linear__list_issues(
     team: "{{linear.team}}",
     cycle: "[id]",
     state: "Todo",           # Only actionable states
     limit: 10                # Never more than needed
   )
   ```

3. **Fetch details only when working:**
   - `list_issues` → Get IDs and titles for queue
   - `get_issue` → Fetch full details ONLY for current todo

4. **Don't re-fetch what's in frontmatter:**
   If todo file already has `linear_issue: HOL-123` and `linear_url`, don't call `get_issue` just to verify - trust the local data unless reconciling.

5. **Batch awareness:**
   - Sync phase: fetch list once, store IDs
   - Work phases: use stored IDs, fetch one at a time

**Token budget guide:**
| Operation | Typical Tokens | Guidance |
|-----------|----------------|----------|
| `list_issues(limit: 10)` | ~3k | Acceptable |
| `list_issues(limit: 50)` | ~12k | Avoid |
| `get_issue(id)` | ~500 | Use freely for current todo |
| `list_cycles` | ~200 | Lightweight, OK |

## Architecture: Linear as Source of Truth

**Linear is the single source of truth for all work items.** Local todo files in `{{paths.todos_dir}}/` are **temporary working documents** that provide detailed implementation context during work, but Linear determines:

- What work exists
- Current status of work
- Priority and ordering
- Relationships between work items

This architecture supports multiple input sources:
- **Code review findings** → Create Linear tickets → Generate local todos
- **Customer feedback** → Create Linear tickets → Generate local todos
- **Manual planning** → Create Linear tickets → Generate local todos

### Data Flow

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Input Sources  │────▶│     Linear      │────▶│   Local Todos   │
│  - Review       │     │  (Source of     │     │  (Working docs  │
│  - Feedback     │     │   Truth)        │     │   with details) │
│  - Planning     │     │                 │     │                 │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                              │                        │
                              │    Sync & Reconcile    │
                              │◀───────────────────────│
                              │                        │
                              ▼                        ▼
                        Status updates          Completion/blocking
                        from agent work         synced back to Linear
```

### Local Todos Are Ephemeral

**Important:** Local todo files are working documents that exist only during active work:

1. **Created** when syncing from Linear or starting work on an issue
2. **Used** during planning and implementation for detailed notes
3. **Deleted** after PR is merged (Linear is the permanent record)

**Never commit todo files in feature PRs.** The `{{paths.todos_dir}}/` folder changes should only be committed:
- As part of cleanup after merge (deleting completed todos)
- When updating the todo system itself

### Discrepancy Resolution

When there's a conflict between Linear and local todo:
- **Linear status wins** - If Linear says "Done", todo is done
- **Local todo provides detail** - Implementation notes, acceptance criteria
- **PR state is ground truth** - If PR merged, work is complete

## Introduction

This skill implements the Ralph Wiggum loop technique for autonomous todo processing:

1. **Sync** - Pull latest from Linear, reconcile with local todos
2. **Pick** next pending todo (sorted by priority: P1 → P2 → P3)
3. **Validate** - Check for discrepancies between todo file, Linear ticket, and existing PRs
4. **Plan** the implementation (`/workflows:plan` or use existing plan in todo)
5. **Work** on it (`/workflows:work`)
6. **Review** the work automatically (`/workflows:review`)
7. **Compound** learnings (`/workflows:compound`)
8. **PR** - Open pull request with Linear reference
9. **Wait for CI** - Monitor CI status
10. **Auto-merge** - Merge when CI passes (unless `--no-merge`)
11. **Mark** todo as completed, update Linear, optionally clean up
12. **Repeat** until all done or max iterations reached

### Context Window Architecture

**Problem:** LLM context windows are limited. A 1000-line skill doc + planning output + work output + review output = context overflow.

**Solution:** Each heavy phase runs in a **separate Task subagent** with its own context window.

```
┌─────────────────────────────────────────────────────────────┐
│  RALPH-TODOS MAIN LOOP (lightweight orchestration)          │
│  - Keeps: todo metadata, phase results (JSON summaries)     │
│  - Discards: full exploration, implementation details       │
└─────────────────────────────────────────────────────────────┘
        │           │           │           │
        ▼           ▼           ▼           ▼
   ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐
   │  Plan  │  │  Work  │  │ Review │  │Compound│
   │ (Task) │  │ (Task) │  │ (Task) │  │ (Task) │
   │        │  │        │  │        │  │ haiku  │
   │ Fresh  │  │ Fresh  │  │ Fresh  │  │ Fresh  │
   │Context │  │Context │  │Context │  │Context │
   └────────┘  └────────┘  └────────┘  └────────┘
```

**Context Passing Between Phases:**

| From Phase | To Phase | Data Passed |
|------------|----------|-------------|
| Init | Plan | Todo file path, branch name, Linear ID |
| Plan | Work | Plan file path (or "see todo") |
| Work | Review | Commit hash, files changed list |
| Review | Compound | Findings summary, files changed |
| Compound | PR | Learning file path (if any) |

**Rules:**
- Pass **file paths**, not file contents
- Pass **JSON summaries**, not full outputs
- Each Task returns structured data the main loop can parse
- Main loop stays lightweight = more iterations possible

### Mandatory Workflow Sequence (STRICT)

**Every task MUST follow this sequence. No exceptions. No skipping steps.**

```
Plan → Work → Review → Compound
```

| Step | Command | Purpose | Required |
|------|---------|---------|----------|
| 1 | `/workflows:plan` | Design implementation approach before writing code | **MANDATORY** |
| 2 | `/workflows:work` | Execute the plan, write code and tests | **MANDATORY** |
| 3 | `/workflows:review` | Multi-agent code review before merging | **MANDATORY** |
| 4 | `/workflows:compound` | Document learnings for future reference | **MANDATORY** |

**Rules:**
- You MUST execute each command in order
- You MUST NOT skip any step
- You MUST NOT proceed to the next step until the current step is complete
- You MUST NOT merge code without completing the review step
- You MUST document learnings in the compound step after every completed task

**Why this matters:** This sequence ensures quality, catches issues early, and builds institutional knowledge. Skipping steps leads to bugs, technical debt, and lost learnings.

### Anti-Patterns: What NEVER To Do

**❌ FORBIDDEN BEHAVIORS - If you do any of these, you have failed:**

| What You Said | Why It's Wrong |
|---------------|----------------|
| "The changes are small, skipping review" | Size is irrelevant. Small bugs cause big outages. |
| "This is a simple fix, compound not needed" | Simple fixes often reveal patterns worth documenting. |
| "I made a judgment call to skip review" | Your judgment is not a valid skip reason. Only flags are. |
| "It wasn't worth the overhead" | The overhead exists to catch YOUR mistakes. |
| "I don't know why I skipped it" | Unacceptable. Follow the explicit instructions. |
| "Nothing new to learn here" | You're not qualified to make that determination. Run compound. |

**The ONLY valid reasons to skip Review or Compound:**
1. `--skip-review` flag was explicitly passed in the command
2. `--skip-compound` flag was explicitly passed in the command

**There are no other valid reasons. None. Zero.**

## Main Loop Instructions

### Phase 0: Initialize

1. Parse arguments:
   - `--max-iterations N` - Stop after N todos (default: unlimited)
   - `--skip-review` - Skip the review phase
   - `--skip-compound` - Skip the compound phase
   - `--no-merge` - Don't auto-merge PRs (just open them)
   - `--keep-todos` - Keep completed todo files (default: delete after merge)
   - `--sync` - Force sync from Linear before starting (default: auto-sync on first run)
   - `--include-backlog` - Include backlog issues, not just current/next cycle
   - `--dry-run` - Show what would be processed without doing it

2. Run sync phase (Phase 0.5) if `--sync` flag or first iteration

### Phase 0.5: Sync from Linear (Source of Truth)

**Ensure local todos are in sync with Linear:**

1. **Get current and next cycle:**
   ```
   mcp__linear__list_cycles(teamId: "{{linear.team}}", type: "current")
   mcp__linear__list_cycles(teamId: "{{linear.team}}", type: "next")
   ```

2. **Fetch relevant Linear issues (cycle-aware, with limits):**

   ⚠️ **Always use `limit` to avoid context bloat.** See "Linear Context Efficiency" section.

   ```
   # Current cycle issues (highest priority)
   mcp__linear__list_issues(
     team: "{{linear.team}}",
     cycle: "[current-cycle-id]",
     state: ["Todo", "In Progress"],
     limit: 15  # Context-efficient limit
   )

   # Next cycle issues (planning ahead)
   mcp__linear__list_issues(
     team: "{{linear.team}}",
     cycle: "[next-cycle-id]",
     state: ["Todo", "In Progress"],
     limit: 10  # Fewer for planning horizon
   )

   # Backlog (only if --include-backlog flag)
   mcp__linear__list_issues(
     team: "{{linear.team}}",
     state: ["Backlog"],
     labels: {{linear.backlog_labels}},
     limit: 10  # Backlog is lower priority
   )
   ```

2. **For each Linear issue, check local state:**

   | Linear State | Local Todo | Action |
   |--------------|------------|--------|
   | Exists | Missing | Create local todo from Linear |
   | Done | Pending | Mark local todo complete |
   | In Progress | Missing | Create local todo, mark in progress |
   | Backlog | Completed | Reopen local todo (Linear is truth) |

3. **Create missing local todos from Linear:**
   ```
   {{tools.package_manager}} .claude/skills/ralph-todos/scripts/todo-utils.ts create \
     --priority [from Linear priority or p2 default] \
     --title "[Linear issue title]" \
     --linear-issue "[HOL-XXX]" \
     --linear-url "[Linear URL]" \
     --tags "[from Linear labels]"
   ```

4. **Reconcile completed items:**
   - If Linear is "Done" but local is "pending" → Mark local complete
   - If local is "completed" but Linear is not "Done" → Update Linear to "Done"

5. **Report sync results:**
   ```
   Sync complete:
   - Created: X new local todos from Linear
   - Updated: Y status changes
   - Orphaned: Z local todos without Linear ticket (consider cleanup)
   ```

### Phase 0.6: Prepare Work Queue

1. Read all files in `{{paths.todos_dir}}/` directory
2. Filter to only `*-pending-*` files
3. **Sort by cycle, then priority:**
   - Current cycle issues first (from Linear `cycle` field)
   - Next cycle issues second
   - Backlog (no cycle) last
   - Within each group: p1 → p2 → p3, then by number
4. If no pending todos found:
   - Check Linear for issues without local todos
   - If found, create local todos and continue
   - If none, report "All work complete!"

**Prioritization order:**
```
1. Current cycle + P1
2. Current cycle + P2
3. Current cycle + P3
4. Next cycle + P1
5. Next cycle + P2
6. Next cycle + P3
7. Backlog + P1 (if --include-backlog)
8. Backlog + P2 (if --include-backlog)
9. Backlog + P3 (if --include-backlog)
```

### Phase 0.7: Discovery & Upfront Clarification (CRITICAL)

**IMPORTANT: Before starting ANY work, review ALL todos and ask ALL clarifying questions upfront.**

This phase prevents the loop from stopping mid-execution due to unclear requirements.

1. **Review all pending todos in the queue:**
   ```
   For each todo in work_queue:
     - Read the todo file completely
     - Read the associated Linear ticket (mcp__linear__get_issue)
     - Identify any ambiguities, missing info, or decisions needed
   ```

2. **Collect clarifying questions:**
   For each todo, identify questions about:
   - **Unclear requirements**: What exactly should happen?
   - **Missing context**: What existing code/patterns should be followed?
   - **Decision points**: Which approach should be taken when multiple exist?
   - **Dependencies**: What needs to exist first?
   - **Scope boundaries**: What's in/out of scope?

3. **Ask ALL questions at once using AskUserQuestion:**
   ```
   AskUserQuestion(
     questions: [
       {
         header: "HOL-51",
         question: "The URL validation consolidation requires choosing between...",
         options: [
           { label: "Approach A", description: "..." },
           { label: "Approach B", description: "..." }
         ],
         multiSelect: false
       },
       {
         header: "HOL-52",
         question: "For extracting shared primitives, should we...",
         options: [...]
       }
       // ... questions for all todos that need clarification
     ]
   )
   ```

4. **Record answers in todo files:**
   - Update each todo's frontmatter or body with the clarified decisions
   - This ensures answers persist and don't need to be asked again

5. **If no questions needed:**
   - Proceed directly to Phase 1
   - Log: "All todos have clear requirements, proceeding with work"

**Why this matters:**
- Asking questions one-at-a-time interrupts the autonomous flow
- Users prefer batch clarification over repeated interruptions
- Recorded answers help if the loop needs to restart

### Phase 0.8: Commit to ALL Todos (No Skipping)

**CRITICAL: The loop MUST attempt ALL todos in the queue, not just "easy" ones.**

DO NOT skip a todo because:
- It seems complex
- It requires refactoring
- It affects multiple files
- It might be harder than other todos

A todo should ONLY be marked as blocked (not skipped) when:
- A genuine external blocker exists (missing API, credentials, etc.)
- A P1 review finding cannot be resolved
- A dependency on another incomplete todo
- A technical impossibility (not just difficulty)

**If uncertain about a todo:**
- Attempt it anyway
- If truly blocked, mark as blocked with specific reason
- NEVER silently skip to "easier" todos

### Phase 1: Pick Next Todo

For each iteration:

1. Read first pending todo file from sorted list
2. Parse YAML frontmatter to extract:
   - `status` (must be "pending")
   - `priority` (p1/p2/p3)
   - `issue_id` (local identifier like "001")
   - `linear_issue` (Linear reference like "HOL-123")
   - `linear_url` (full Linear URL)
   - `tags`
   - `dependencies` (skip if dependencies not completed)

3. Check dependencies:
   - If todo has dependencies array, verify each dependency todo is completed
   - If any dependency is still pending, skip this todo and try next

4. Announce: "Starting work on: [todo title] (Priority: [priority])"

### Phase 1.5: Validate & Reconcile Discrepancies

**Before starting work, validate state consistency (Linear is source of truth):**

1. **Fetch Linear ticket (REQUIRED for all todos):**
   ```
   mcp__linear__get_issue(id: "HOL-XXX")
   ```

   If no `linear_issue` in todo frontmatter:
   - Search Linear by title: `mcp__linear__list_issues(query: "[todo title]")`
   - If found, update todo frontmatter with Linear reference
   - If not found, create Linear ticket and update frontmatter

2. **Check Linear status (source of truth):**

   | Linear State | Action |
   |--------------|--------|
   | Done | Mark local todo complete, skip work |
   | Cancelled | Delete local todo, skip work |
   | Blocked | Mark local todo blocked, skip work |
   | In Progress | Continue (another agent may be working) |
   | Todo/Backlog | Proceed with work |

3. **Check if PR already exists for this branch:**
   ```bash
   gh pr list --head "feature/[slug]" --json number,state,merged
   ```
   - If merged PR exists → Mark todo complete, update Linear to "Done"
   - If open PR exists → Continue from existing PR (don't recreate)

4. **Reconciliation actions (Linear wins):**
   - **Linear "Done" but todo pending**: Mark local complete, skip
   - **Linear "Cancelled"**: Delete local todo, skip
   - **PR merged but Linear not "Done"**: Update Linear to "Done"
   - **Titles mismatch**: Update local todo title from Linear (Linear is truth)
   - **Missing Linear ticket**: Create one (all work must be tracked)

### Phase 1.7: Mark Linear as In Progress

**Before starting work, update Linear status:**

```
mcp__linear__update_issue(
  id: "[linear-id]",
  state: "In Progress"
)
```

This signals to the team that work has begun on this issue.

### Phase 2: Create Branch

1. Ensure on main branch and pull latest:
   ```bash
   git checkout main && git pull origin main
   ```

2. Create feature branch from todo slug:
   - Extract slug from filename (e.g., `001-pending-p1-extract-duplicate-utility-functions.md` → `extract-duplicate-utility-functions`)
   - Create branch: `feature/[slug]` or `fix/[slug]` based on tags

3. Switch to new branch

### Phase 3: Plan (if needed)

Check if todo already has sufficient plan:
- If "Proposed Solutions" and "Recommended Action" sections exist with clear steps → Skip planning
- If todo is sparse or lacks implementation details → Run planning via **Task subagent**

**Why Task instead of Skill:** Task spawns a separate context window, preventing context bloat in the main loop. The plan agent can explore freely without consuming your context budget.

When running plan:
```
Task:
  subagent_type: Plan
  description: "Plan [todo-title]"
  prompt: |
    Plan the implementation for this todo.

    Todo file: [absolute path to todo file]
    Branch: [current branch name]
    Linear issue: [HOL-XXX]

    Read the todo file, explore the codebase, and create an implementation plan.
    Write the plan to a file at: .claude/plans/[issue-id]-plan.md

    Return ONLY the plan file path when complete.
```

**Capture the output:** Store the returned plan file path for Phase 4.

### Phase 4: Work

Execute the implementation via **Task subagent**:

**Why Task instead of Skill:** Work is the heaviest phase - lots of file reads, edits, test runs. A fresh context window lets the agent focus entirely on implementation without the overhead of loop instructions.

```
Task:
  subagent_type: general-purpose
  description: "Implement [todo-title]"
  prompt: |
    Implement the changes for this todo.

    Todo file: [absolute path to todo file]
    Plan file: [path from Phase 3, or "see todo file" if skipped]
    Branch: [current branch name]
    Linear issue: [HOL-XXX]

    Instructions:
    1. Read the todo and plan files
    2. Implement all acceptance criteria
    3. Run `bin/lint` and `bin/test` - fix any failures
    4. Commit changes with message: "feat: [todo title]\n\nFixes [HOL-XXX]"

    Return a JSON object when complete:
    {
      "status": "success" | "failed",
      "commit_hash": "[hash]",
      "files_changed": ["list", "of", "files"],
      "tests_passed": true | false,
      "error": null | "[error message]"
    }
```

**Handle the result:**
- If `status: "failed"` → Mark todo as blocked, continue to next
- If `status: "success"` → Proceed to Phase 5

### Phase 5: Review (MANDATORY)

> ⛔ **MANDATORY STEP** - You MUST run `/workflows:review`.
> The ONLY valid skip reason is if `--skip-review` was in the original command arguments.
>
> **INVALID skip reasons (NEVER use these):**
> - "Changes are small"
> - "Simple fix"
> - "Not worth the overhead"
> - "Made a judgment call"
> - Any reason YOU invented

**If `--skip-review` was NOT passed, you MUST run review. No exceptions.**

Run code review via **Task subagent**:

**Why Task instead of Skill:** Review spawns multiple sub-agents internally. Using Task isolates all that context churn from the main loop.

```
Task:
  subagent_type: general-purpose
  description: "Review [todo-title]"
  prompt: |
    Review the code changes for this todo.

    Branch: [current branch name]
    Commit: [commit hash from Phase 4]
    Linear issue: [HOL-XXX]
    Files changed: [list from Phase 4]

    Run `/workflows:review` on the latest changes.

    Return a JSON object when complete:
    {
      "status": "pass" | "fail",
      "p1_findings": [{"title": "...", "description": "...", "file": "...", "line": N}],
      "p2_findings": [...],
      "p3_findings": [...],
      "summary": "Brief summary of review results"
    }
```

**Do NOT skip this step.** The review catches issues before they reach CI or production.

The review produces findings categorized as:
- **P1 (Critical)**: Security issues, data loss risks, breaking changes
- **P2 (Important)**: Code quality, performance, maintainability
- **P3 (Minor)**: Style, documentation, nice-to-haves

**Handle review findings:**

#### P1 Findings (Blocking)
1. Attempt to fix the issue
2. Re-run `bin/lint` and `bin/test`
3. If fix successful, commit and continue
4. If fix fails after 2 attempts → Mark todo as blocked

#### P2/P3 Findings (Non-blocking, Create Follow-ups)

For each P2/P3 finding, **create a new follow-up todo and Linear ticket:**

1. **Generate new todo file:**
   ```
   {{tools.package_manager}} .claude/skills/ralph-todos/scripts/todo-utils.ts create \
     --priority [p2|p3] \
     --title "[Finding title]" \
     --parent-issue "[current-issue-id]" \
     --tags "review-finding,follow-up" \
     --linear-labels "{{linear.followup_labels_csv}}"
   ```

2. **Create Linear ticket with follow-up labels in current cycle:**
   ```
   # First get current cycle
   mcp__linear__list_cycles(teamId: "{{linear.team}}", type: "current")

   mcp__linear__create_issue(
     title: "[Finding title]",
     team: "{{linear.team}}",
     labels: {{linear.followup_labels}},
     cycle: "[current-cycle-id]",
     description: "## From Review\n\nParent: [HOL-XXX]\nFound during review of: [todo title]\n\n## Details\n[Finding description]"
   )
   ```

3. **Update new todo with Linear reference:**
   - Add `linear_issue: HOL-XXX` to frontmatter
   - Add `linear_url: https://linear.app/...` to frontmatter

4. **Add comment on parent Linear ticket:**
   ```
   mcp__linear__create_comment(
     issueId: "[parent-linear-id]",
     body: "Review complete. Created follow-up issues:\n- HOL-XXX: [title]\n- HOL-YYY: [title]"
   )
   ```

### Phase 6: Compound (MANDATORY)

> ⛔ **MANDATORY STEP** - You MUST run `/workflows:compound`.
> The ONLY valid skip reason is if `--skip-compound` was in the original command arguments.
>
> **INVALID skip reasons (NEVER use these):**
> - "Nothing new learned"
> - "Changes are trivial"
> - "No patterns to document"
> - "Made a judgment call"
> - Any reason YOU invented

**If `--skip-compound` was NOT passed, you MUST run compound. No exceptions.**

Document learnings via **Task subagent**:

**Why Task instead of Skill:** Compound needs to analyze what happened but doesn't need the full loop context. A fresh agent with just the summary info is more efficient.

```
Task:
  subagent_type: general-purpose
  model: haiku  # Compound is lightweight, use faster/cheaper model
  description: "Compound [todo-title]"
  prompt: |
    Document learnings from this completed todo.

    Todo file: [absolute path to todo file]
    Linear issue: [HOL-XXX]
    Files changed: [list from Phase 4]
    Review findings: [summary from Phase 5]

    Run `/workflows:compound` to document:
    - What was learned
    - Patterns discovered
    - Future prevention strategies

    Return a JSON object when complete:
    {
      "status": "complete",
      "learning_file": "[path to created learning doc, if any]",
      "summary": "Brief summary of what was documented"
    }
```

This captures institutional knowledge without bloating the main loop context.

### Phase 6.5: Workflow Verification Gate (BLOCKING)

**⛔ STOP. Before creating a PR, you MUST verify all mandatory steps were executed.**

Fill out this checklist BEFORE proceeding:

```yaml
workflow_verification:
  plan_ran: [yes | skipped-existing-plan]
  work_ran: [yes]
  review_ran: [yes | skipped-via-flag]      # "no" is INVALID unless --skip-review was passed
  compound_ran: [yes | skipped-via-flag]    # "no" is INVALID unless --skip-compound was passed
  flags_received: [list any --skip-* flags from original command, or "none"]
```

**BLOCKING CONDITIONS:**
- If `review_ran` is "no" and `--skip-review` was NOT in original args → **GO BACK AND RUN REVIEW NOW**
- If `compound_ran` is "no" and `--skip-compound` was NOT in original args → **GO BACK AND RUN COMPOUND NOW**

**You may NOT proceed to Phase 7 until this gate passes.**

---

### Phase 7: Open PR

Create pull request:

1. Push branch to origin:
   ```bash
   git push -u origin [branch-name]
   ```

2. Create PR with `gh pr create`:
   - Title: Todo title
   - Body template:
     ```markdown
     ## Summary
     [Brief description from todo]

     ## Changes
     [List of changes made]

     ## Linear Issue
     Closes [HOL-XXX] (if linear_issue present in frontmatter)

     ## Test Plan
     [From acceptance criteria]

     ## Review Notes
     [Any P2/P3 findings created as follow-ups]

     ## Screenshots
     [If UI changes]
     ```

3. Add Linear issue link if `linear_issue` present in frontmatter

### Phase 8: Wait for CI & Auto-Merge (unless --no-merge)

**CRITICAL: Always wait for CI before merging. Never skip this step.**

Monitor CI and auto-merge when ready:

1. **Wait for CI checks to complete (REQUIRED):**
   ```bash
   gh pr checks [PR-number] --watch --fail-fast
   ```

   This command blocks until all checks complete. Do NOT proceed until this returns successfully.

2. **Check for blocking issues:**
   - CI must be green (all checks passing) - **MANDATORY**
   - No P1 review findings remaining
   - PR must be approved (if required by branch protection)

3. **If CI fails:**
   - Read the failure logs: `gh pr checks [PR-number]`
   - Attempt to fix the failing tests/lint
   - Push fixes and wait for CI again
   - If cannot fix after 2 attempts, mark todo as blocked

4. **If all conditions met, auto-merge:**
   ```bash
   gh pr merge [PR-number] --squash --delete-branch
   ```

5. **If merge fails:**
   - Check for merge conflicts → attempt rebase
   - Check for missing approvals → log and continue without merging
   - Log error and continue to next todo

### Phase 9: Mark Complete & Clean Up

1. **Update Linear ticket (assign cycle if missing, then close):**
   ```
   # If issue has no cycle, assign to current cycle
   mcp__linear__list_cycles(teamId: "{{linear.team}}", type: "current")

   mcp__linear__update_issue(
     id: "[linear-id]",
     state: "Done",
     cycle: "[current-cycle-id]"  # Assign to current cycle if not already set
   )

   mcp__linear__create_comment(
     issueId: "[linear-id]",
     body: "Resolved by Claude agent.\n\nPR: [PR URL]\nMerged: [timestamp]\nCycle: [cycle-name]"
   )
   ```

2. **Delete the completed todo file (default behavior):**

   Linear is the source of truth - local todo files are ephemeral working documents.

   ```bash
   rm {{paths.todos_dir}}/[todo-filename]
   ```

   **Do NOT commit this deletion in the feature branch.** The deletion happens locally
   after merge. If you want to persist deletions, do a separate cleanup commit on main:
   ```bash
   git checkout main && git pull origin main
   git add -A && git commit -m "chore: clean up completed todos"
   git push origin main
   ```

3. **If `--keep-todos` flag is set:**
   - Keep the todo file but update frontmatter:
     ```yaml
     status: completed
     completed_at: [ISO timestamp]
     pr_url: [PR URL]
     merged_at: [ISO timestamp if merged]
     completed_by: "claude-agent"
     ```
   - Rename file from `pending` to `completed`:
     ```
     001-pending-p1-foo.md → 001-completed-p1-foo.md
     ```

4. Switch back to main branch:
   ```bash
   git checkout main && git pull origin main
   ```

### Phase 10: Continue or Stop

Check continuation criteria:

1. If `--max-iterations` reached → Stop, report summary
2. If no more pending todos → Stop, report summary
3. Otherwise → Go to Phase 1 (next todo)

## Handling Blocked Todos

When a todo cannot be completed:

1. Rename file: `001-pending-p1-foo.md` → `001-blocked-p1-foo.md`

2. Update frontmatter:
   ```yaml
   status: blocked
   blocked_at: [ISO timestamp]
   blocked_reason: [Why it's blocked]
   blocked_by: "claude-agent"
   ```

3. Update Linear ticket:
   ```
   mcp__linear__update_issue(
     id: "[linear-id]",
     state: "Blocked"
   )

   mcp__linear__create_comment(
     issueId: "[linear-id]",
     body: "Blocked by Claude agent.\n\nReason: [blocked_reason]\n\nAttempted fixes:\n[list of attempts]"
   )
   ```

4. Add work log entry explaining what was attempted and why it failed

5. Continue to next todo (don't stop the loop)

## Linear Labels for Tracking

The skill uses these Linear labels for organization:

| Label | Purpose | Required |
|-------|---------|----------|
| `{{project.label}}` | Project label for {{project.name}} work | **Always** |
| `follow-up` | Issues created from review findings | **Always** |
| `p1`, `p2`, `p3` | Priority labels matching todo priorities | One of these |
| `review-finding` | Issues originating from code review | When applicable |
| `agent-blocked` | Issues that Claude couldn't complete | When applicable |

**IMPORTANT: All issues created by this skill MUST have:**
1. `{{project.label}}` label (project identifier)
2. `follow-up` label (tracks agent-created work)
3. Assigned to current cycle

**Ensure required labels exist:**
```
mcp__linear__list_issue_labels(team: "{{linear.team}}")
```
If not present, create them:
```
mcp__linear__create_issue_label(
  name: "follow-up",
  color: "#F7DC6F",
  description: "Follow-up work from review findings"
)

mcp__linear__create_issue_label(
  name: "{{project.label}}",
  color: "#4A90D9",
  description: "{{project.name}} work"
)
```

## Discrepancy Detection (Linear is Source of Truth)

The skill automatically detects and handles discrepancies, always deferring to Linear:

| Discrepancy | Detection | Resolution |
|-------------|-----------|------------|
| Linear "Done", todo pending | Linear state is "Done" | Mark local todo complete, skip work |
| Linear "Cancelled", todo exists | Linear state is "Cancelled" | Delete local todo |
| Linear "Blocked", todo pending | Linear state is "Blocked" | Mark local blocked, add reason |
| PR merged, Linear not "Done" | `gh pr list` returns merged | Update Linear to "Done" |
| Todo completed, Linear open | Local status is "completed" | Update Linear to "Done" |
| Missing Linear ticket | No `linear_issue` in frontmatter | Create Linear ticket, update frontmatter |
| Linear issue exists, no local todo | Linear issue found, no matching file | Create local todo from Linear |
| Orphan local todo (no Linear) | Local todo without `linear_issue` | Create Linear ticket or delete if stale |
| Title mismatch | Linear title ≠ local title | Update local title from Linear |

## Completion Report

When loop ends, output summary:

```markdown
## Ralph Loop Summary

**Processed:** X todos
**Completed:** Y
**Merged:** Z
**Blocked:** W
**Remaining:** R

### Completed & Merged PRs
- [PR Title](PR URL) - [todo filename] ✅ Merged

### Open PRs (pending review/merge)
- [PR Title](PR URL) - [todo filename] ⏳ Awaiting merge

### Blocked Items
- [todo filename]: [reason]

### Follow-up Issues Created
- HOL-XXX: [title] (P2)
- HOL-YYY: [title] (P3)

### Discrepancies Resolved
- [todo filename]: Marked complete (PR was already merged)

### Next Steps
- Review and merge open PRs
- Investigate blocked items
- Address follow-up issues
- Run `/ralph-todos` again for remaining items
```

## Output Completion Promise

When all todos are processed OR max iterations reached, output this **with accountability details**:

```
<promise>
RALPH_TODOS_COMPLETE
executed_workflow:
  todos_processed: [number]
  todos_completed: [number]
  todos_blocked: [number]
  for_each_todo:
    - issue: [HOL-XXX]
      plan: [ran | skipped-existing-plan]
      work: [ran]
      review: [ran | skipped-via-flag]
      compound: [ran | skipped-via-flag]
      pr: [merged | open | none]
flags_received: [--skip-review, --skip-compound, or "none"]
</promise>
```

**IMPORTANT:** If any todo shows `review: skipped` or `compound: skipped` without the corresponding flag in `flags_received`, you have violated the workflow requirements.

This signals the loop has finished its current run AND provides accountability for what was actually executed.

## Examples

### Example 1: Full Autonomous Run
```
User: /ralph-todos
Claude: Starting Ralph todo loop...

Found 15 pending todos:
- P1: 3 items
- P2: 9 items
- P3: 3 items

Starting with: 001-pending-p1-extract-duplicate-utility-functions.md

✓ Validated: No discrepancies found
✓ Created branch: feature/extract-duplicate-utility-functions
✓ Plan: Using existing plan from todo
✓ Work: Implementation complete
✓ Review:
  - P1: 0 issues
  - P2: 2 issues → Created HOL-145, HOL-146 as follow-ups
  - P3: 1 issue → Created HOL-147 as follow-up
✓ Compound: Documented learnings
✓ PR: Opened #42
✓ CI: All checks passing
✓ Merged: PR #42 squash-merged
✓ Cleanup: Marked todo complete, closed HOL-123

Moving to next todo...
```

### Example 2: With Discrepancy Resolution
```
User: /ralph-todos --max-iterations 1
Claude: Starting Ralph todo loop (max 1 iteration)...

Processing: 004-pending-p2-create-api-client-layer.md

⚠️ Discrepancy detected:
  - PR #15 exists and was merged 2 days ago
  - Todo is still marked as pending
  - Linear HOL-41 is still "In Progress"

Resolving:
  ✓ Marked todo as completed
  ✓ Updated Linear HOL-41 to "Done"
  ✓ Added attribution comment to Linear

No work needed - todo was already complete.
Moving to next pending todo would exceed max iterations.

Summary:
- Processed: 1 todo
- Discrepancies resolved: 1
- Actual work done: 0

<promise>RALPH_TODOS_COMPLETE</promise>
```

### Example 3: Blocked by Review
```
Claude: Working on: 004-pending-p2-create-api-client-layer.md

✓ Created branch: feature/create-api-client-layer
✓ Plan complete
✓ Work: Implementation complete
✗ Review found P1 issue: SQL injection vulnerability in query builder

Attempting fix (1/2)...
✗ Fix failed: Tests still failing

Attempting fix (2/2)...
✗ Fix failed: Unable to resolve without API spec changes

Marking as blocked: P1 review finding - SQL injection vulnerability requires API changes.

Updated:
- Todo: 004-blocked-p2-create-api-client-layer.md
- Linear HOL-44: Status → Blocked, added comment

Moving to next todo...
```

## Safety Mechanisms

1. **Max iterations**: Always respects `--max-iterations` flag
2. **Dependency checking**: Skips todos with unmet dependencies
3. **Review gate**: P1 findings block completion (unless --skip-review)
4. **CI gate**: Won't merge until CI passes
5. **Clean state**: Always returns to main branch between todos
6. **No force pushes**: Never uses `--force` on git operations
7. **Blocked marking**: Failed todos marked blocked, not deleted
8. **Attribution**: All actions attributed to "claude-agent"
9. **No todo commits in PRs**: Todo file changes are never committed in feature PRs

## Autonomy Requirements

**This loop runs autonomously. NEVER ask the user:**
- "Should I continue to the next todo?"
- "Do you want me to proceed?"
- "Ready to start the next iteration?"

The loop continues automatically until:
- All todos are complete
- `--max-iterations` limit reached
- An unrecoverable error occurs

If blocked on a specific todo, mark it as blocked and **immediately continue** to the next todo without user confirmation.

## Configuration

The skill reads from todo files in `{{paths.todos_dir}}/` directory with this structure:

```yaml
---
status: pending|completed|blocked
priority: p1|p2|p3
issue_id: "001"              # Local sequential ID
linear_issue: "HOL-123"      # Linear issue identifier
linear_url: "https://..."    # Full Linear URL
tags: [tag1, tag2]
dependencies: ["other-issue-id"]
completed_at: "ISO timestamp"
completed_by: "claude-agent"
pr_url: "https://github.com/..."
merged_at: "ISO timestamp"
---

# Todo Title

## Problem Statement
...

## Acceptance Criteria
- [ ] Criterion 1
- [ ] Criterion 2
```

## Integration with Linear (Source of Truth)

**All work items MUST have a Linear ticket.** Linear is the source of truth for:
- What work exists
- Current status
- Priority
- Relationships and dependencies

### Required Integration Points

When `linear_issue` is present (e.g., "HOL-123"):
- PR description includes "Closes HOL-123"
- On completion, updates Linear issue status to "Done"
- Adds attribution comment with agent name and PR URL
- Review findings create linked follow-up issues
- Uses `follow-up` label for review-generated issues

### Sync Behavior

1. **On start**: Sync from Linear to create/update local todos
2. **On complete**: Update Linear status to "Done"
3. **On block**: Update Linear status to "Blocked" with reason
4. **Always**: Linear status takes precedence over local status

### Supporting Multiple Input Sources

The Linear-first architecture supports various input sources:

| Source | Flow | Labels |
|--------|------|--------|
| Code review | `/workflows:review` → Linear ticket → Local todo | `follow-up`, `review-finding` |
| Customer feedback | Feedback system → Linear ticket → Local todo | `customer-feedback`, `Feature` or `Bug` |
| Manual planning | Create Linear ticket → Sync → Local todo | Various |
| Automated audit | Audit tool → Linear ticket → Local todo | `audit`, `security` or `performance` |

All sources converge on Linear, and the ralph-todos loop processes them uniformly.

## Troubleshooting

**"No pending todos found"**
- Check `{{paths.todos_dir}}/` directory exists
- Verify files have `-pending-` in filename
- Check file frontmatter has `status: pending`

**"Dependency not met"**
- Check dependency todo exists and is completed
- Dependencies use the issue_id, not filename

**"Review blocked progress"**
- P1 findings require resolution
- Use `--skip-review` to bypass (not recommended)
- Check review output for specific issues

**"CI checks failing"**
- Run `bin/lint` and `bin/test` locally
- Check GitHub Actions logs for specific failures
- May need to fix and push additional commits

**"Auto-merge failed"**
- Check branch protection rules
- May need manual approval
- Use `--no-merge` to skip auto-merge

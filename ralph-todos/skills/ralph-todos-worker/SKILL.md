---
name: ralph-todos-worker
description: Single-iteration worker for ralph-todos-parallel. Processes one todo in an isolated git worktree. Not meant to be invoked directly.
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  - Skill
  - TodoWrite
  - mcp__linear__*
---

# Ralph Todos Worker

You are a worker instance running in an isolated git worktree. You have been assigned a single todo to process. This skill is invoked by `ralph-todos-parallel` and should not be run directly.

## Arguments (provided by orchestrator)

```
worktreePath: Absolute path to your git worktree
todoFile: Path to the todo file (relative to main repo)
linearId: Linear issue UUID
linearIssue: Linear issue identifier (e.g., HOL-123)
skipReview: Whether to skip review phase (default: false)
skipCompound: Whether to skip compound phase (default: false)
noMerge: Whether to skip auto-merge (default: false)
```

## Important: Worktree Context

**You are NOT in the main repository.** All commands must run from your assigned worktree:

```bash
cd [worktreePath]
# All commands run here
```

The worktree has:
- Its own `node_modules/` (already installed by orchestrator)
- Its own git index and working tree
- A feature branch already checked out

## Workflow

### Phase 1: Validate State

1. **Verify worktree exists:**
   ```bash
   cd [worktreePath] && pwd
   ```

2. **Verify Linear issue is "In Progress":**
   ```
   mcp__linear__get_issue(id: "[linearId]")
   ```
   If NOT "In Progress", abort immediately - another worker may have claimed it.

3. **Verify you're on the correct branch:**
   ```bash
   cd [worktreePath] && git branch --show-current
   ```

### Phase 2: Read Todo

1. Read the todo file from the main repo path (orchestrator provides it)
2. Extract:
   - Title
   - Problem statement
   - Acceptance criteria
   - Any existing plan

### Phase 3: Plan (if needed)

Check if todo has sufficient implementation plan:
- If "Proposed Solutions" and "Recommended Action" exist with clear steps → Skip
- Otherwise → Run planning:

```
Skill: workflows:plan
Args: [todoFile path]
```

**Note:** Plan workflow should reference the worktree path for any file operations.

### Phase 4: Work

Execute the implementation in your worktree:

```
Skill: workflows:work
Args: [todoFile or plan path]
```

All code changes happen in `[worktreePath]`.

### Phase 5: Review (unless skipReview)

Run code review on your changes:

```
Skill: workflows:review
Args: latest
```

**Handle review findings:**

| Finding Type | Action |
|--------------|--------|
| P1 (Critical) | Attempt fix (2 tries max), then mark blocked |
| P2/P3 | Create follow-up Linear tickets, continue |

If P1 cannot be fixed:
```
Return: {
  status: "blocked",
  error: "P1 review finding: [description]",
  ...
}
```

### Phase 6: Compound (unless skipCompound)

Document learnings:

```
Skill: workflows:compound
```

### Phase 7: Commit and Push

1. **Stage changes:**
   ```bash
   cd [worktreePath] && git add -A
   ```

2. **Commit:**
   ```bash
   cd [worktreePath] && git commit -m "$(cat <<'EOF'
   [commit message]

   Closes [linearIssue]

   Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
   EOF
   )"
   ```

3. **Push:**
   ```bash
   cd [worktreePath] && git push -u origin [branch-name]
   ```

### Phase 8: Create PR

Create pull request using `gh`:

```bash
cd [worktreePath] && gh pr create --title "[title]" --body "$(cat <<'EOF'
## Summary
[Brief description]

## Changes
[List of changes]

## Linear Issue
Closes [linearIssue]

## Test Plan
[From acceptance criteria]

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

### Phase 9: Wait for CI and Merge (unless noMerge)

1. **Wait for CI:**
   ```bash
   cd [worktreePath] && gh pr checks [PR-number] --watch --fail-fast
   ```

2. **If CI passes, merge:**
   ```bash
   cd [worktreePath] && gh pr merge [PR-number] --squash --delete-branch
   ```

3. **If CI fails:**
   - Attempt fix (2 tries max)
   - If cannot fix, return with `status: "failed"`

### Phase 10: Return Result

**CRITICAL:** You must return a structured result that the orchestrator can parse.

Output this exact format at the end of your work:

```json
<worker-result>
{
  "status": "completed" | "blocked" | "failed",
  "linearId": "[linearId]",
  "linearIssue": "[linearIssue]",
  "prUrl": "https://github.com/.../pull/123",
  "prNumber": 123,
  "merged": true | false,
  "error": null | "[error message]",
  "followUps": ["HOL-124", "HOL-125"]
}
</worker-result>
```

## Result Status Meanings

| Status | Meaning | Orchestrator Action |
|--------|---------|---------------------|
| `completed` | PR created and optionally merged | Update Linear to Done, cleanup worktree |
| `blocked` | P1 finding or dependency issue | Update Linear to Blocked, keep worktree |
| `failed` | CI failure or unexpected error | Revert Linear to Todo, keep worktree |

## Error Handling

1. **Git conflicts:** Attempt rebase from main, if fails → blocked
2. **CI failures:** 2 fix attempts, then → failed
3. **P1 review findings:** 2 fix attempts, then → blocked
4. **Network errors:** Retry 3 times, then → failed

## Constraints

- **Never switch branches** - stay on your assigned branch
- **Never modify main** - all work in worktree only
- **Never force push** - always regular push
- **Always return result** - orchestrator depends on structured output
- **Respect flags** - honor skipReview, skipCompound, noMerge

## Example Execution

```
Orchestrator invokes:
  Task ralph-todos-worker
  Prompt: "Process todo with:
    worktreePath: /path/to/.worktrees/ralph-HOL-123
    todoFile: todos/001-pending-p1-fix-auth-bug.md
    linearId: abc-123-uuid
    linearIssue: HOL-123
    skipReview: false
    skipCompound: false
    noMerge: false"

Worker:
  1. cd /path/to/.worktrees/ralph-HOL-123
  2. Verify Linear HOL-123 is "In Progress"
  3. Read todos/001-pending-p1-fix-auth-bug.md
  4. Run workflows:plan (if needed)
  5. Run workflows:work
  6. Run workflows:review
  7. Create follow-up tickets for P2/P3 findings
  8. Run workflows:compound
  9. git add, commit, push
  10. gh pr create
  11. gh pr checks --watch
  12. gh pr merge --squash
  13. Return:
     <worker-result>
     {
       "status": "completed",
       "linearId": "abc-123-uuid",
       "linearIssue": "HOL-123",
       "prUrl": "https://github.com/org/repo/pull/45",
       "prNumber": 45,
       "merged": true,
       "error": null,
       "followUps": ["HOL-124"]
     }
     </worker-result>
```

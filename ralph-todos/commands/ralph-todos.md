---
name: ralph-todos
description: Autonomous todo processing loop. Picks todos from todos/ folder (P1 first), runs Plan → Work → Review → Compound workflow, opens PRs, marks complete/blocked.
argument-hint: "[--max-iterations N] [--skip-review] [--skip-compound] [--dry-run]"
---

# Ralph Todos: Autonomous Todo Processing Loop

You are now running the Ralph Todos autonomous loop. Follow the SKILL.md instructions at `.claude/skills/ralph-todos/SKILL.md`.

## Arguments Received

$ARGUMENTS

## Your Task

Execute the Ralph loop as described in the skill file:

1. **Initialize**: Parse any arguments (--max-iterations, --skip-review, --skip-compound, --dry-run)
2. **Pick**: Use the todo-utils script to get the next pending todo
3. **Branch**: Create feature branch from main
4. **Plan**: Run `/workflows:plan` if needed (skip if todo has clear implementation plan)
5. **Work**: Run `/workflows:work` to implement the changes
6. **Review**: Run `/workflows:review` to check quality (unless --skip-review)
7. **Compound**: Run `/workflows:compound` to document learnings (unless --skip-compound)
8. **PR**: Open pull request with Linear reference if present
9. **Mark**: Mark todo as completed (or blocked if issues)
10. **Repeat**: Continue until all todos done or max iterations reached

## Helper Script

Use this script for todo operations:

```bash
# Get next pending todo
bun .claude/skills/ralph-todos/scripts/todo-utils.ts next

# Mark todo as completed
bun .claude/skills/ralph-todos/scripts/todo-utils.ts complete <filename> [pr-url]

# Mark todo as blocked
bun .claude/skills/ralph-todos/scripts/todo-utils.ts block <filename> <reason>

# List all pending todos
bun .claude/skills/ralph-todos/scripts/todo-utils.ts list pending
```

## Important

- Always return to main branch between todos
- Never force push
- Mark blocked items and continue (don't stop the loop)
- Output `<promise>RALPH_TODOS_COMPLETE</promise>` when finished

Begin by parsing arguments and getting the next todo to work on.

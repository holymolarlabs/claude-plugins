# HolyMolarLabs Claude Plugins

Shared Claude Code plugins for the HolyMolarLabs polyrepo.

## Plugins

### ralph-todos

Autonomous todo processing loop with Linear integration.

**Features:**
- Syncs todos with Linear issues
- Runs Plan → Work → Review → Compound workflow
- Opens PRs and auto-merges when CI passes
- Parallel processing with git worktrees

**Usage:**
```bash
/ralph-todos                    # Process todos sequentially
/ralph-todos-parallel           # Process todos in parallel (3 workers)
```

## Setup

### 1. Create config in your repo

Create `ralph.toml` at your repo root:

```toml
[project]
name = "my-project"
label = "my-label"

[linear]
team = "HolyMolarLabs"
followup_labels = ["follow-up", "my-label"]
backlog_labels = ["my-label"]

[paths]
todos_dir = "todos"

[tools]
package_manager = "bun"
```

### 2. Sync the plugin

From the alpha repo:

```bash
bin/sync-ralph-plugin ../path/to/your/repo
```

Or sync all known repos:

```bash
bin/sync-ralph-plugin --all
```

### 3. Keep in sync

When the plugin is updated, re-run the sync command. The sync is idempotent and preserves your local config.

## Configuration Reference

See `ralph-todos/schema/ralph.schema.toml` for full schema documentation.

### Key configuration options

| Key | Description | Default |
|-----|-------------|---------|
| `project.name` | Project identifier | (required) |
| `project.label` | Primary Linear label | (required) |
| `linear.team` | Linear team name | HolyMolarLabs |
| `linear.followup_labels` | Labels for follow-up issues | (required) |
| `linear.backlog_labels` | Labels to filter backlog | (required) |
| `paths.todos_dir` | Todo files directory | todos |
| `tools.package_manager` | bun/npm/pnpm/yarn | bun |
| `parallel.max_workers` | Max parallel workers | 3 |

## Development

### Updating the plugin

1. Edit files in `ralph-todos/`
2. For templated files, edit `SKILL.template.md`
3. Test with: `bin/sync-ralph-plugin ../taptaptap/mono`
4. Run the skill to verify: `/ralph-todos --dry-run`

### Template variables

The following placeholders are replaced during sync:

- `{{project.name}}` - From `[project] name`
- `{{project.label}}` - From `[project] label`
- `{{linear.team}}` - From `[linear] team`
- `{{linear.followup_labels}}` - JSON array
- `{{linear.followup_labels_csv}}` - Comma-separated
- `{{linear.backlog_labels}}` - JSON array
- `{{paths.todos_dir}}` - From `[paths] todos_dir`
- `{{tools.package_manager}}` - From `[tools] package_manager`

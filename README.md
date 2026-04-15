# ccs — Claude Code Session Manager

A CLI tool for managing [Claude Code](https://claude.ai/code) sessions with star, tag, and archive metadata.

Claude Code's built-in session picker (`claude --resume`) becomes hard to navigate when you have dozens of parallel sessions. ccs adds the missing organization layer: star important sessions, tag them by category, archive old ones, and find the right session fast.

## Install

Requires [Deno](https://deno.land/) 2.x.

```bash
# Compile to binary
deno task compile

# Move to PATH
mv ccs /usr/local/bin/ccs
# or
mv ccs ~/bin/ccs
```

Or run directly without compiling:

```bash
deno task dev -- list
```

## Quick Start

```bash
ccs                          # List sessions grouped by project
ccs -d 7                     # Last 7 days only
ccs -s                       # Starred sessions only
ccs s 3f7248                 # Star a session (by short ID)
ccs t 841cd2 frontend        # Tag a session
ccs r cleanup                # Copy resume command to clipboard
```

## Commands

| Command | Short | Description |
|---------|-------|-------------|
| `ccs list` | `ccs`, `ccs ls` | List sessions (default: grouped by project) |
| `ccs star <query>` | `ccs s` | Toggle star |
| `ccs tag <query> <tag>` | `ccs t` | Add tag |
| `ccs untag <query> <tag>` | | Remove tag |
| `ccs archive <query>` | `ccs a` | Toggle archive |
| `ccs resume <query>` | `ccs r` | Copy `claude --resume <id>` to clipboard |
| `ccs info <query>` | `ccs i` | Show session details |
| `ccs projects` | | List all projects |
| `ccs doctor` | | Check environment |
| `ccs gc` | | Clean orphan metadata |

Session rename is done inside the CC session with `/rename`.

## List Options

| Flag | Short | Description |
|------|-------|-------------|
| `--starred` | `-s` | Starred only |
| `--tag <tag>` | `-t` | Filter by tag |
| `--project <name>` | `-p` | Filter by project (substring match) |
| `--days <n>` | `-d` | Updated within n days |
| `--limit <n>` | `-n` | Limit results |
| `--group <key>` | | Group by: `project` (default), `tag` |
| `--flat` | | Flat list with pagination |
| `--page <n>` | | Page number (with `--flat`) |
| `--all` | | Include archived |
| `--archived` | | Archived only |
| `--json` | `-j` | JSON output |

## Query Resolution

`<query>` matches sessions by:

1. Session ID (exact or prefix, e.g., `3f7248`)
2. Display name (exact, prefix, or substring match)

If multiple sessions match, ccs shows the candidates and exits without acting.

## How It Works

ccs reads Claude Code's internal session data:

- `~/.claude/projects/*/sessions-index.json` — session metadata (read-only)
- `~/.claude/projects/*/*.jsonl` — session history, including user-set names from `/rename`

ccs stores its own metadata (stars, tags, archive status) in:

- `~/.claude/ccs-metadata.json`

ccs never modifies Claude Code's data. Metadata writes use atomic operations (write to `.tmp`, then rename).

## Bulk Operations

Combine `--json` output with `jq` for bulk actions:

```bash
# Archive all sessions with 10 or fewer messages
ccs list -j | jq -r '.[] | select(.messageCount <= 10 and .starred == false) | .id[:6]' | xargs -I{} ccs a {}

# Preview before archiving
ccs list -j | jq '.[] | select(.messageCount <= 10) | {id: .id[:6], name: .displayName, msgs: .messageCount}'
```

## Related

- [Feature request: session picker improvements](https://github.com/anthropics/claude-code/issues/47726)
- [Feature request: pin/star sessions](https://github.com/anthropics/claude-code/issues/46474)
- [Feature request: session manager UI](https://github.com/anthropics/claude-code/issues/46862)

## License

MIT

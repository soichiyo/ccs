#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env --allow-sys

// ccs — Claude Code Session Manager
// Single-file CLI for managing Claude Code sessions with star/tag/archive metadata.

import { homedir } from "node:os";
import { join, basename } from "node:path";

// --- Types ---

type SessionEntry = {
  sessionId: string;
  fullPath?: string;
  firstPrompt?: string;
  summary?: string;
  messageCount?: number;
  created?: string;
  modified?: string;
  gitBranch?: string;
  projectPath?: string;
  isSidechain?: boolean;
};

type SessionMeta = {
  starred?: boolean;
  tags?: string[];
  archived?: boolean;
  updatedAt?: string;
};

type MetadataStore = {
  version: number;
  sessions: Record<string, SessionMeta>;
};

type SessionView = {
  id: string;
  displayName: string;
  entry: SessionEntry;
  meta: SessionMeta;
  projectName: string;
};

// --- Paths ---

const HOME = homedir();
const CLAUDE_PROJECTS_DIR = join(HOME, ".claude", "projects");
const METADATA_PATH = join(HOME, ".claude", "ccs-metadata.json");
const METADATA_TMP = METADATA_PATH + ".tmp";
const METADATA_BAK = METADATA_PATH + ".bak";

// --- Data Loading ---

// Extract user-set session name from JSONL (type: "agent-name" → agentName)
function extractAgentName(jsonlPath: string): string | undefined {
  try {
    const raw = Deno.readTextFileSync(jsonlPath);
    // Search from end (rename can happen multiple times, last one wins)
    const lines = raw.trimEnd().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const d = JSON.parse(lines[i]);
        if (d.type === "agent-name" && typeof d.agentName === "string") {
          return d.agentName;
        }
      } catch { /* skip malformed lines */ }
    }
  } catch { /* file not readable */ }
  return undefined;
}

// Extract basic metadata from JSONL when not in sessions-index
function extractSessionFromJsonl(jsonlPath: string, projectDir: string): { entry: SessionEntry; projectName: string; agentName?: string } | undefined {
  try {
    const stat = Deno.statSync(jsonlPath);
    const raw = Deno.readTextFileSync(jsonlPath);
    const lines = raw.trimEnd().split("\n");

    const sid = basename(jsonlPath).replace(".jsonl", "");
    let agentName: string | undefined;
    let firstPrompt: string | undefined;
    let cwd: string | undefined;
    let gitBranch: string | undefined;
    let messageCount = 0;
    let created: string | undefined;
    let modified: string | undefined;

    for (let i = 0; i < lines.length; i++) {
      try {
        const d = JSON.parse(lines[i]);
        if (d.type === "agent-name" && typeof d.agentName === "string") {
          agentName = d.agentName;
        }
        if (!cwd && typeof d.cwd === "string") cwd = d.cwd;
        if (!gitBranch && typeof d.gitBranch === "string" && d.gitBranch) gitBranch = d.gitBranch;
        if (d.type === "user" && d.message && !firstPrompt) {
          const content = d.message?.content;
          if (typeof content === "string") firstPrompt = content;
          else if (Array.isArray(content)) {
            const textBlock = content.find((b: { type: string }) => b.type === "text");
            if (textBlock) firstPrompt = textBlock.text;
          }
        }
        if (d.type === "user" || d.type === "assistant") messageCount++;
        if (d.timestamp) {
          if (!created) created = d.timestamp;
          modified = d.timestamp;
        }
      } catch { /* skip */ }
    }

    const projectPath = cwd || "";
    const projectName = projectPath ? basename(projectPath) : projectDir;

    return {
      entry: {
        sessionId: sid,
        fullPath: jsonlPath,
        firstPrompt,
        messageCount,
        created,
        modified: modified || stat.mtime?.toISOString(),
        gitBranch: gitBranch || "",
        projectPath,
        isSidechain: false,
      },
      projectName,
      agentName,
    };
  } catch { return undefined; }
}

function loadAllSessionIndexes(): { entry: SessionEntry; projectName: string; agentName?: string }[] {
  const results: { entry: SessionEntry; projectName: string; agentName?: string }[] = [];
  const seenIds = new Set<string>();
  let dirs: Deno.DirEntry[];
  try {
    dirs = [...Deno.readDirSync(CLAUDE_PROJECTS_DIR)];
  } catch {
    return results;
  }

  for (const dir of dirs) {
    if (!dir.isDirectory) continue;
    const projectDirPath = join(CLAUDE_PROJECTS_DIR, dir.name);

    // 1. Load from sessions-index.json
    const indexPath = join(projectDirPath, "sessions-index.json");
    try {
      const raw = Deno.readTextFileSync(indexPath);
      const data = JSON.parse(raw);
      if (data.version !== undefined && data.version !== 1) {
        console.error(`warn: ${indexPath} has unknown version ${data.version}, skipping`);
        continue;
      }
      const entries: unknown[] = data.entries ?? [];
      for (const e of entries) {
        const entry = e as Record<string, unknown>;
        if (typeof entry.sessionId !== "string") continue;
        seenIds.add(entry.sessionId);
        const projectPath = typeof entry.projectPath === "string" ? entry.projectPath : "";
        const projectName = projectPath ? basename(projectPath) : dir.name;
        const fullPath = typeof entry.fullPath === "string" ? entry.fullPath : undefined;
        const agentName = fullPath ? extractAgentName(fullPath) : undefined;
        results.push({ entry: entry as unknown as SessionEntry, projectName, agentName });
      }
    } catch {
      // no index file
    }

    // 2. Pick up unindexed JSONL files
    try {
      for (const file of Deno.readDirSync(projectDirPath)) {
        if (!file.isFile || !file.name.endsWith(".jsonl")) continue;
        const sid = file.name.replace(".jsonl", "");
        if (seenIds.has(sid)) continue;
        seenIds.add(sid);
        const jsonlPath = join(projectDirPath, file.name);
        const result = extractSessionFromJsonl(jsonlPath, dir.name);
        if (result) results.push(result);
      }
    } catch {
      // skip unreadable dirs
    }
  }
  return results;
}

function loadMetadata(): MetadataStore {
  try {
    const raw = Deno.readTextFileSync(METADATA_PATH);
    const data = JSON.parse(raw);
    if (data.version === 1 && typeof data.sessions === "object") {
      return data as MetadataStore;
    }
    console.error("warn: metadata has unexpected format, starting fresh");
    return { version: 1, sessions: {} };
  } catch {
    return { version: 1, sessions: {} };
  }
}

function saveMetadata(store: MetadataStore): void {
  const json = JSON.stringify(store, null, 2) + "\n";
  // backup existing
  try {
    Deno.copyFileSync(METADATA_PATH, METADATA_BAK);
  } catch {
    // no existing file to backup
  }
  // atomic write
  Deno.writeTextFileSync(METADATA_TMP, json);
  Deno.renameSync(METADATA_TMP, METADATA_PATH);
}

// --- Merge & Display ---

// Sanitize text for single-line table display
function sanitize(str: string): string {
  return str.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").replace(/[<>]/g, "").trim();
}

function getDisplayName(entry: SessionEntry, _meta: SessionMeta, agentName?: string): string {
  // Priority: CC /rename name > summary > firstPrompt > id
  if (agentName) return sanitize(agentName);
  if (entry.summary) return sanitize(entry.summary);
  if (entry.firstPrompt) return sanitize(entry.firstPrompt);
  return entry.sessionId.slice(0, 8);
}

function mergeSessions(
  raw: { entry: SessionEntry; projectName: string; agentName?: string }[],
  metadata: MetadataStore,
): SessionView[] {
  return raw
    .filter((r) => !r.entry.isSidechain)
    .map((r) => {
      const meta = metadata.sessions[r.entry.sessionId] ?? {};
      return {
        id: r.entry.sessionId,
        displayName: getDisplayName(r.entry, meta, r.agentName),
        entry: r.entry,
        meta,
        projectName: r.projectName,
      };
    });
}

function sortSessions(sessions: SessionView[]): SessionView[] {
  return sessions.sort((a, b) => {
    // starred first
    const aStarred = a.meta.starred ? 1 : 0;
    const bStarred = b.meta.starred ? 1 : 0;
    if (aStarred !== bStarred) return bStarred - aStarred;
    // then by modified desc
    const aTime = a.entry.modified ?? a.entry.created ?? "";
    const bTime = b.entry.modified ?? b.entry.created ?? "";
    return bTime.localeCompare(aTime);
  });
}

// --- Query Resolution ---

function resolveSession(query: string, sessions: SessionView[]): SessionView {
  // 1. exact id match
  const byId = sessions.filter((s) => s.id === query);
  if (byId.length === 1) return byId[0];

  // 1b. id prefix match (short ID like "841cd2")
  if (/^[0-9a-f]{4,}$/i.test(query)) {
    const byIdPrefix = sessions.filter((s) => s.id.startsWith(query.toLowerCase()));
    if (byIdPrefix.length === 1) return byIdPrefix[0];
    if (byIdPrefix.length > 1) {
      console.error(`Ambiguous ID prefix: "${query}" matches ${byIdPrefix.length} sessions\n`);
      console.log(renderTable(byIdPrefix));
      console.error(`\nSpecify a longer ID.`);
      Deno.exit(1);
    }
  }

  // 2. exact displayName match
  const byExact = sessions.filter((s) => s.displayName === query);
  if (byExact.length === 1) return byExact[0];

  // 3. prefix match
  const byPrefix = sessions.filter((s) =>
    s.displayName.toLowerCase().startsWith(query.toLowerCase())
  );
  if (byPrefix.length === 1) return byPrefix[0];

  // 4. substring match (case-insensitive)
  const q = query.toLowerCase();
  const bySub = sessions.filter((s) => s.displayName.toLowerCase().includes(q));
  if (bySub.length === 1) return bySub[0];

  // ambiguous or not found
  const candidates = bySub.length > 0 ? bySub : byPrefix;
  if (candidates.length > 1) {
    console.error(`Ambiguous: "${query}" matches ${candidates.length} sessions\n`);
    console.log(renderTable(candidates));
    console.error(`\nSpecify a longer name or use session ID.`);
    Deno.exit(1);
  }

  console.error(`No session matching "${query}"`);
  Deno.exit(1);
}

// --- Rendering ---

// ANSI color helpers
const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  reset: "\x1b[0m",
};

// CJK-aware display width (fullwidth chars = 2 columns)
function displayWidth(str: string): number {
  let w = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0)!;
    if (
      (cp >= 0x1100 && cp <= 0x115f) ||  // Hangul Jamo
      (cp >= 0x2e80 && cp <= 0x303e) ||  // CJK Radicals, Kangxi, CJK Symbols
      (cp >= 0x3040 && cp <= 0x33bf) ||  // Hiragana, Katakana, CJK Compat
      (cp >= 0x3400 && cp <= 0x4dbf) ||  // CJK Unified Ext A
      (cp >= 0x4e00 && cp <= 0xa4cf) ||  // CJK Unified, Yi
      (cp >= 0xac00 && cp <= 0xd7af) ||  // Hangul Syllables
      (cp >= 0xf900 && cp <= 0xfaff) ||  // CJK Compat Ideographs
      (cp >= 0xfe30 && cp <= 0xfe6f) ||  // CJK Compat Forms
      (cp >= 0xff01 && cp <= 0xff60) ||  // Fullwidth Forms
      (cp >= 0xffe0 && cp <= 0xffe6) ||  // Fullwidth Signs
      (cp >= 0x20000 && cp <= 0x2fffd) || // CJK Ext B-F
      (cp >= 0x30000 && cp <= 0x3fffd)    // CJK Ext G
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

// Truncate by display width
function truncate(str: string, maxWidth: number): string {
  let w = 0;
  let i = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0)!;
    const cw = (
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0x303e) ||
      (cp >= 0x3040 && cp <= 0x33bf) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x4e00 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7af) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff01 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x2fffd) ||
      (cp >= 0x30000 && cp <= 0x3fffd)
    ) ? 2 : 1;
    if (w + cw > maxWidth - 1) {
      return str.slice(0, i) + "…";
    }
    w += cw;
    i += ch.length;
  }
  return str;
}

// Pad to target display width
function padRight(str: string, targetWidth: number): string {
  const w = displayWidth(str);
  if (w >= targetWidth) return str;
  return str + " ".repeat(targetWidth - w);
}

function relativeTime(iso: string | undefined): string {
  if (!iso) return "-";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "今";
  if (mins < 60) return `${mins}分`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}時間`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}日`;
  const months = Math.floor(days / 30);
  return `${months}ヶ月`;
}

type TableOptions = { showProject?: boolean };

function renderTable(sessions: SessionView[], opts: TableOptions = {}): string {
  if (sessions.length === 0) return "  (no sessions)";

  const ID_W = 6;
  const NAME_W = 36;
  const TAG_W = 14;
  const MSG_W = 5;
  const TIME_W = 6;
  const showProj = opts.showProject ?? false;

  // Header
  let header = `  ${padRight("ID", ID_W)} │ ${padRight("SESSION", NAME_W)} │ ${padRight("TAGS", TAG_W)} │ ${padRight("MSGS", MSG_W)} │ 更新`;
  let sep = "──" + "─".repeat(ID_W) + "─┼─" + "─".repeat(NAME_W) + "─┼─" + "─".repeat(TAG_W) + "─┼─" + "─".repeat(MSG_W) + "─┼─" + "─".repeat(TIME_W);
  if (showProj) {
    header += " │ PROJECT";
    sep += "─┼─" + "─".repeat(16);
  }

  const lines: string[] = [c.dim(header), c.dim(sep)];
  for (const s of sessions) {
    const star = s.meta.starred ? c.yellow("★") : " ";
    const shortId = c.dim(s.id.slice(0, ID_W));
    const name = padRight(truncate(s.displayName, NAME_W), NAME_W);
    const tags = s.meta.tags?.length ? c.cyan(`[${s.meta.tags.join(",")}]`) : "";
    const tagsRaw = s.meta.tags?.length ? `[${s.meta.tags.join(",")}]` : "";
    const tagDisplay = tags + " ".repeat(Math.max(0, TAG_W - displayWidth(tagsRaw)));
    const msgs = padRight(`${s.entry.messageCount ?? "?"}`, MSG_W);
    const time = c.dim(padRight(relativeTime(s.entry.modified ?? s.entry.created), TIME_W));
    const divider = c.dim("│");
    let line = `${star} ${shortId} ${divider} ${name} ${divider} ${tagDisplay} ${divider} ${msgs} ${divider} ${time}`;
    if (showProj) {
      line += ` ${divider} ${c.dim(s.projectName)}`;
    }
    lines.push(line);
  }
  return lines.join("\n");
}

function renderJson(sessions: SessionView[]): string {
  return JSON.stringify(
    sessions.map((s) => ({
      id: s.id,
      displayName: s.displayName,
      starred: s.meta.starred ?? false,
      tags: s.meta.tags ?? [],
      archived: s.meta.archived ?? false,
      messageCount: s.entry.messageCount,
      created: s.entry.created,
      modified: s.entry.modified,
      gitBranch: s.entry.gitBranch,
      projectName: s.projectName,
      projectPath: s.entry.projectPath,
    })),
    null,
    2,
  );
}

// --- Clipboard ---

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    const cmd = new Deno.Command("pbcopy", { stdin: "piped" });
    const proc = cmd.spawn();
    const writer = proc.stdin.getWriter();
    await writer.write(new TextEncoder().encode(text));
    await writer.close();
    const status = await proc.status;
    return status.success;
  } catch {
    return false;
  }
}

// --- Commands ---

const DEFAULT_PAGE_SIZE = 20;

function cmdList(args: string[], allSessions: SessionView[]): void {
  let sessions = [...allSessions];
  const flags = parseFlags(args);

  // filter
  if (!flags.all && !flags.archived) {
    sessions = sessions.filter((s) => !s.meta.archived);
  }
  if (flags.archived && !flags.all) {
    sessions = sessions.filter((s) => s.meta.archived);
  }
  if (flags.starred) {
    sessions = sessions.filter((s) => s.meta.starred);
  }
  if (flags.tag) {
    sessions = sessions.filter((s) => s.meta.tags?.includes(flags.tag!));
  }
  if (flags.project) {
    const p = flags.project.toLowerCase();
    sessions = sessions.filter((s) => s.projectName.toLowerCase().includes(p));
  }
  if (flags.days) {
    const cutoff = Date.now() - flags.days * 86400000;
    sessions = sessions.filter((s) => {
      const t = s.entry.modified ?? s.entry.created;
      return t ? new Date(t).getTime() >= cutoff : false;
    });
  }

  const total = sessions.length;

  if (flags.json) {
    if (flags.limit) sessions = sessions.slice(0, flags.limit);
    console.log(renderJson(sessions));
  } else if (flags.flat) {
    // Flat mode (no grouping): paginate
    const pageSize = flags.limit ?? (flags.all ? total : DEFAULT_PAGE_SIZE);
    const page = flags.page ?? 1;
    const start = (page - 1) * pageSize;
    const paged = sessions.slice(start, start + pageSize);
    const totalPages = Math.ceil(total / pageSize);

    console.log(renderTable(paged, { showProject: true }));

    if (totalPages > 1) {
      console.log(c.dim(`\n  Page ${page}/${totalPages} (${total} sessions) — next: ccs list --flat --page ${page + 1}`));
    } else {
      console.log(`\n  ${paged.length} sessions`);
    }
  } else {
    // Default: group by project (or specified key)
    const groupBy = flags.group ?? "project";
    if (flags.limit) sessions = sessions.slice(0, flags.limit);
    renderGrouped(sessions, groupBy);
  }
}

function renderGrouped(sessions: SessionView[], groupBy: string): void {
  const groups = new Map<string, SessionView[]>();
  for (const s of sessions) {
    let key: string;
    switch (groupBy) {
      case "project":
        key = s.projectName || "(unknown)";
        break;
      case "tag": {
        const tags = s.meta.tags ?? [];
        if (tags.length === 0) {
          key = "(untagged)";
        } else {
          // session appears in first tag group
          key = tags[0];
        }
        break;
      }
      default:
        key = s.projectName || "(unknown)";
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(s);
  }

  // Sort groups: tagged/named groups first, untagged/unknown last
  const sortedGroups = [...groups.entries()].sort((a, b) => {
    const aSpecial = a[0].startsWith("(") ? 1 : 0;
    const bSpecial = b[0].startsWith("(") ? 1 : 0;
    if (aSpecial !== bSpecial) return aSpecial - bSpecial;
    return a[0].localeCompare(b[0]);
  });

  let total = 0;
  for (const [groupName, items] of sortedGroups) {
    console.log(`\n  ${c.bold(groupName)} (${items.length})`);
    console.log(renderTable(items));
    total += items.length;
  }
  console.log(c.dim(`\n  ${total} sessions`));
}

// Parse comma-separated queries: "1,2,3" → ["1", "2", "3"]
function parseQueries(arg: string): string[] {
  return arg.split(",").map((s) => s.trim()).filter(Boolean);
}

function cmdStar(args: string[], allSessions: SessionView[], store: MetadataStore): void {
  if (args.length < 1) {
    console.error("Usage: ccs star <query[,query,...]>");
    Deno.exit(1);
  }
  const queries = parseQueries(args[0]);
  for (const q of queries) {
    const session = resolveSession(q, allSessions);
    const meta = store.sessions[session.id] ?? {};
    meta.starred = !meta.starred;
    meta.updatedAt = new Date().toISOString();
    store.sessions[session.id] = meta;
    console.log(`${meta.starred ? "★ Starred" : "  Unstarred"}: ${session.displayName}`);
  }
  saveMetadata(store);
}

function cmdTag(args: string[], allSessions: SessionView[], store: MetadataStore): void {
  if (args.length < 2) {
    console.error("Usage: ccs tag <query[,query,...]> <tag> [tag...]");
    Deno.exit(1);
  }
  const queries = parseQueries(args[0]);
  const tags = args.slice(1);
  for (const q of queries) {
    const session = resolveSession(q, allSessions);
    const meta = store.sessions[session.id] ?? {};
    if (!meta.tags) meta.tags = [];
    for (const tag of tags) {
      if (!meta.tags.includes(tag)) meta.tags.push(tag);
    }
    meta.updatedAt = new Date().toISOString();
    store.sessions[session.id] = meta;
    console.log(`Tagged "${session.displayName}" with [${tags.join(", ")}]`);
  }
  saveMetadata(store);
}

function cmdUntag(args: string[], allSessions: SessionView[], store: MetadataStore): void {
  if (args.length < 2) {
    console.error("Usage: ccs untag <query[,query,...]> <tag> [tag...]");
    Deno.exit(1);
  }
  const queries = parseQueries(args[0]);
  const tags = args.slice(1);
  for (const q of queries) {
    const session = resolveSession(q, allSessions);
    const meta = store.sessions[session.id] ?? {};
    if (meta.tags) {
      meta.tags = meta.tags.filter((t) => !tags.includes(t));
    }
    meta.updatedAt = new Date().toISOString();
    store.sessions[session.id] = meta;
    console.log(`Untagged "${session.displayName}" from [${tags.join(", ")}]`);
  }
  saveMetadata(store);
}

function cmdArchive(args: string[], allSessions: SessionView[], store: MetadataStore): void {
  if (args.length < 1) {
    console.error("Usage: ccs archive <query[,query,...]>");
    Deno.exit(1);
  }
  const queries = parseQueries(args[0]);
  for (const q of queries) {
    const session = resolveSession(q, allSessions);
    const meta = store.sessions[session.id] ?? {};
    meta.archived = !meta.archived;
    meta.updatedAt = new Date().toISOString();
    store.sessions[session.id] = meta;
    console.log(`${meta.archived ? "📦 Archived" : "📤 Unarchived"}: ${session.displayName}`);
  }
  saveMetadata(store);
}

async function cmdResume(args: string[], allSessions: SessionView[]): Promise<void> {
  if (args.length < 1) {
    console.error("Usage: ccs resume <query> [--print]");
    Deno.exit(1);
  }
  const flags = parseFlags(args);
  const query = args.filter((a) => !a.startsWith("--"))[0];
  const session = resolveSession(query, allSessions);
  const cmd = `claude --resume ${session.id}`;

  if (flags.print) {
    console.log(cmd);
    return;
  }

  const ok = await copyToClipboard(cmd);
  if (ok) {
    console.log(`Copied to clipboard: ${cmd}`);
  } else {
    console.log(`Copy failed. Run manually:\n\n  ${cmd}`);
  }
}

function cmdInfo(args: string[], allSessions: SessionView[]): void {
  if (args.length < 1) {
    console.error("Usage: ccs info <query> [--json]");
    Deno.exit(1);
  }
  const flags = parseFlags(args);
  const query = args.filter((a) => !a.startsWith("--"))[0];
  const s = resolveSession(query, allSessions);

  if (flags.json) {
    console.log(renderJson([s]));
    return;
  }

  console.log(`Session:     ${s.displayName}`);
  console.log(`ID:          ${s.id}`);
  console.log(`Project:     ${s.projectName} (${s.entry.projectPath ?? "?"})`);
  console.log(`Messages:    ${s.entry.messageCount ?? "?"}`);
  console.log(`Created:     ${s.entry.created ?? "?"}`);
  console.log(`Modified:    ${s.entry.modified ?? "?"}`);
  console.log(`Branch:      ${s.entry.gitBranch || "-"}`);
  console.log(`Starred:     ${s.meta.starred ? "★" : "no"}`);
  console.log(`Tags:        ${s.meta.tags?.join(", ") || "-"}`);
  console.log(`Archived:    ${s.meta.archived ? "yes" : "no"}`);
  if (s.entry.summary) console.log(`Summary:     ${s.entry.summary}`);
}

function cmdProjects(args: string[], allSessions: SessionView[]): void {
  const flags = parseFlags(args);
  const projects = new Map<string, { count: number; path: string }>();
  for (const s of allSessions) {
    const existing = projects.get(s.projectName);
    if (existing) {
      existing.count++;
    } else {
      projects.set(s.projectName, { count: 1, path: s.entry.projectPath ?? "?" });
    }
  }

  if (flags.json) {
    const data = [...projects.entries()].map(([name, v]) => ({
      name,
      path: v.path,
      sessionCount: v.count,
    }));
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  for (const [name, v] of projects) {
    console.log(`${padRight(name, 30)}  ${v.count} sessions  ${v.path}`);
  }
}

function cmdDoctor(allSessions: SessionView[], store: MetadataStore): void {
  // Claude dir
  let projectCount = 0;
  try {
    const dirs = [...Deno.readDirSync(CLAUDE_PROJECTS_DIR)];
    projectCount = dirs.filter((d) => d.isDirectory).length;
    console.log(`Claude dir:     ${CLAUDE_PROJECTS_DIR}         OK`);
  } catch {
    console.log(`Claude dir:     ${CLAUDE_PROJECTS_DIR}         MISSING`);
  }

  console.log(`Projects:       ${projectCount} found${projectCount > 0 ? "                     OK" : "                  WARN"}`);
  console.log(`Sessions:       ${allSessions.length} total                       OK`);

  // Metadata
  const metaCount = Object.keys(store.sessions).length;
  try {
    Deno.statSync(METADATA_PATH);
    console.log(`Metadata:       ${METADATA_PATH}  OK (${metaCount} entries)`);
  } catch {
    console.log(`Metadata:       not yet created                WARN`);
  }

  // Orphans
  const sessionIds = new Set(allSessions.map((s) => s.id));
  const orphans = Object.keys(store.sessions).filter((id) => !sessionIds.has(id));
  if (orphans.length > 0) {
    console.log(`Orphans:        ${orphans.length} metadata without session  WARN`);
  } else {
    console.log(`Orphans:        0                              OK`);
  }

  // Clipboard
  try {
    const cmd = new Deno.Command("which", { args: ["pbcopy"], stdout: "null", stderr: "null" });
    const status = cmd.outputSync();
    console.log(`Clipboard:      pbcopy                         ${status.success ? "OK" : "MISSING"}`);
  } catch {
    console.log(`Clipboard:      pbcopy                         MISSING`);
  }
}

function cmdGc(allSessions: SessionView[], store: MetadataStore): void {
  const sessionIds = new Set(allSessions.map((s) => s.id));
  const orphans = Object.keys(store.sessions).filter((id) => !sessionIds.has(id));

  if (orphans.length === 0) {
    console.log("No orphan metadata found.");
    return;
  }

  console.log(`Found ${orphans.length} orphan metadata entries:\n`);
  for (const id of orphans) {
    const meta = store.sessions[id];
    const name = id.slice(0, 8);
    const tags = meta.tags?.length ? `[${meta.tags.join(",")}]` : "";
    console.log(`  ${name}  ${tags}  ${id}`);
  }

  const buf = new Uint8Array(10);
  Deno.stdout.writeSync(new TextEncoder().encode(`\nRemove ${orphans.length} entries? [y/N] `));
  const n = Deno.stdin.readSync(buf);
  const answer = new TextDecoder().decode(buf.subarray(0, n ?? 0)).trim().toLowerCase();

  if (answer === "y" || answer === "yes") {
    for (const id of orphans) {
      delete store.sessions[id];
    }
    saveMetadata(store);
    console.log(`Removed ${orphans.length} orphan entries.`);
  } else {
    console.log("Cancelled.");
  }
}

// --- Arg Parsing ---

type Flags = {
  all?: boolean;
  archived?: boolean;
  starred?: boolean;
  tag?: string;
  project?: string;
  limit?: number;
  page?: number;
  days?: number;
  group?: string;
  flat?: boolean;
  json?: boolean;
  print?: boolean;
};

function parseFlags(args: string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--all":
        flags.all = true;
        break;
      case "--archived":
        flags.archived = true;
        break;
      case "--starred": case "-s":
        flags.starred = true;
        break;
      case "--tag": case "-t":
        flags.tag = args[++i];
        break;
      case "--project": case "-p":
        flags.project = args[++i];
        break;
      case "--limit": case "-n":
        flags.limit = parseInt(args[++i]);
        break;
      case "--page":
        flags.page = parseInt(args[++i]);
        break;
      case "--days": case "-d":
        flags.days = parseInt(args[++i]);
        break;
      case "--group":
        flags.group = args[++i] ?? "project";
        break;
      case "--flat":
        flags.flat = true;
        break;
      case "--json": case "-j":
        flags.json = true;
        break;
      case "--print":
        flags.print = true;
        break;
    }
  }
  return flags;
}

// --- Help ---

function printHelp(): void {
  console.log(`ccs — Claude Code Session Manager

Commands:
  ccs, ccs list, ccs ls       List sessions (default: grouped by project)
  ccs star,  ccs s <query>    Toggle star
  ccs tag,   ccs t <q> <tag>  Add tag
  ccs untag     <query> <tag> Remove tag
  ccs archive, ccs a <query>  Toggle archive
  ccs resume,  ccs r <query>  Copy resume command to clipboard
  ccs info,    ccs i <query>  Show session details
  ccs projects                List projects
  ccs doctor                  Check environment
  ccs gc                      Clean orphan metadata

  Rename: use /rename inside the CC session.

List options:
  -s, --starred               Show starred only
  -t, --tag <tag>             Filter by tag
  -p, --project <name>        Filter by project
  -d, --days <n>              Sessions updated within n days
  -n, --limit <n>             Limit to n sessions
  --page <n>                  Page number (with --flat)
  --group <key>               Group by: project (default), tag
  --flat                      Flat list with pagination
  --all                       Include archived
  --archived                  Show archived only
  -j, --json                  Output as JSON

Other options:
  --print                     Print to stdout (resume)
  -j, --json                  Output as JSON (info, projects)

Examples:
  ccs -d 7                    Last 7 days
  ccs -s -d 7                 Starred, last 7 days
  ccs -p prairie -n 10        Prairie project, 10 sessions
  ccs s 3f7248                Star by short ID
  ccs r cleanup               Resume by name match`);
}

// --- Main ---

async function main(): Promise<void> {
  const [command, ...args] = Deno.args;

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  const raw = loadAllSessionIndexes();
  const store = loadMetadata();
  const allSessions = sortSessions(mergeSessions(raw, store));

  // No command or flag-only args → default to list
  if (!command || command.startsWith("-")) {
    const listArgs = command ? [command, ...args] : args;
    cmdList(listArgs, allSessions);
    return;
  }

  switch (command) {
    case "list":
    case "ls":
      cmdList(args, allSessions);
      break;
    case "star":
    case "s":
      cmdStar(args, allSessions, store);
      break;
    case "tag":
    case "t":
      cmdTag(args, allSessions, store);
      break;
    case "untag":
      cmdUntag(args, allSessions, store);
      break;
    case "archive":
    case "a":
      cmdArchive(args, allSessions, store);
      break;
    case "resume":
    case "r":
      await cmdResume(args, allSessions);
      break;
    case "info":
    case "i":
      cmdInfo(args, allSessions);
      break;
    case "projects":
      cmdProjects(args, allSessions);
      break;
    case "doctor":
      cmdDoctor(allSessions, store);
      break;
    case "gc":
      cmdGc(allSessions, store);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      Deno.exit(1);
  }
}

main();

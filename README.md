# ccs — Claude Code Session Manager

[Claude Code](https://claude.ai/code) のセッション管理CLIツール。star / tag / archive でセッションを整理できます。

Claude Code の組み込みピッカー（`claude --resume`）は、数十のセッションを並行運用すると探しにくくなります。ccs は足りない整理機能を追加します：重要なセッションにstar、カテゴリ別にtag、古いものをarchive、素早く目的のセッションを見つけて復帰。

## インストール

[Deno](https://deno.land/) 2.x が必要です。

```bash
# バイナリにコンパイル
deno task compile

# PATHに配置
mv ccs /usr/local/bin/ccs
# または
mv ccs ~/bin/ccs
```

コンパイルせず直接実行も可能：

```bash
deno task dev -- list
```

## クイックスタート

```bash
ccs                          # プロジェクト別にセッション一覧
ccs -d 7                     # 直近7日のみ
ccs -s                       # star付きのみ
ccs s 3f7248                 # セッションにstar（短縮IDで指定）
ccs t 841cd2 frontend        # タグ追加
ccs r cleanup                # resume コマンドをクリップボードにコピー
```

## コマンド一覧

| コマンド | 短縮 | 説明 |
|---------|------|------|
| `ccs list` | `ccs`, `ccs ls` | セッション一覧（デフォルト: プロジェクト別） |
| `ccs star <query>` | `ccs s` | star トグル |
| `ccs tag <query> <tag>` | `ccs t` | タグ追加 |
| `ccs untag <query> <tag>` | | タグ削除 |
| `ccs archive <query>` | `ccs a` | archive トグル |
| `ccs resume <query>` | `ccs r` | `claude --resume <id>` をクリップボードにコピー |
| `ccs info <query>` | `ccs i` | セッション詳細表示 |
| `ccs projects` | | プロジェクト一覧 |
| `ccs doctor` | | 環境チェック |
| `ccs gc` | | 不要メタデータの掃除 |

セッション名の変更は CC セッション内で `/rename` を使ってください。

## 複数セッション・複数タグの一括操作

カンマ区切りで複数セッション、スペース区切りで複数タグを指定できます：

```bash
ccs t 841cd2,d0ef6e,3f7248 ops marketing   # 3セッションに2タグ
ccs s 841cd2,65f58f                          # 2セッションをまとめてstar
ccs a 26f4de,277d57,f50a6b                   # 3セッションをまとめてarchive
```

## リストオプション

| フラグ | 短縮 | 説明 |
|-------|------|------|
| `--starred` | `-s` | star付きのみ |
| `--tag <tag>` | `-t` | タグで絞り込み |
| `--project <name>` | `-p` | プロジェクトで絞り込み（部分一致） |
| `--days <n>` | `-d` | 直近n日以内に更新されたもの |
| `--limit <n>` | `-n` | 表示件数制限 |
| `--group <key>` | | グルーピング: `project`（デフォルト）, `tag` |
| `--flat` | | フラット表示 + ページネーション |
| `--page <n>` | | ページ番号（`--flat` と併用） |
| `--all` | | archive済みも含めて表示 |
| `--archived` | | archive済みのみ |
| `--json` | `-j` | JSON出力 |

## クエリの解決

`<query>` は以下の順でセッションを検索します：

1. セッションID（完全一致またはプレフィックス一致、例: `3f7248`）
2. 表示名（完全一致 → 前方一致 → 部分一致、大文字小文字区別なし）

複数のセッションがマッチした場合、候補一覧を表示して操作は実行しません。

## 仕組み

ccs は Claude Code の内部セッションデータを読み取ります（読み取り専用）：

- `~/.claude/projects/*/sessions-index.json` — セッションメタデータ
- `~/.claude/projects/*/*.jsonl` — セッション履歴（`/rename` で設定した名前を含む）

ccs 独自のメタデータ（star / tag / archive）は以下に保存：

- `~/.claude/ccs-metadata.json`

ccs は Claude Code のデータを変更しません。メタデータの書き込みはアトミック操作（`.tmp` に書いてから rename）で行います。

## jq を使った一括操作

`--json` 出力と `jq` を組み合わせて一括処理できます：

```bash
# メッセージ数10以下のセッションを一括archive
ccs list -j | jq -r '.[] | select(.messageCount <= 10 and .starred == false) | .id[:6]' | xargs -I{} ccs a {}

# 事前に対象を確認
ccs list -j | jq '.[] | select(.messageCount <= 10) | {id: .id[:6], name: .displayName, msgs: .messageCount}'
```

## 関連

- [Feature request: session picker improvements](https://github.com/anthropics/claude-code/issues/47726)
- [Feature request: pin/star sessions](https://github.com/anthropics/claude-code/issues/46474)
- [Feature request: session manager UI](https://github.com/anthropics/claude-code/issues/46862)

## ライセンス

MIT

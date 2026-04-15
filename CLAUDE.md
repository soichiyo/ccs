# ccs — Claude Code Session Manager

## プロジェクト概要

Deno製の単一ファイルCLIツール。Claude Codeのセッションを star/tag/archive で整理する。
CC本体の `~/.claude/projects/*/sessions-index.json` を読み取り専用で参照し、独自メタデータを `~/.claude/ccs-metadata.json` に保存する。

## 技術スタック

- Runtime: Deno 2.x
- 外部依存: なし（Deno標準API + node:os, node:path のみ）
- ファイル構成: `ccs.ts` 単一ファイル
- ビルド: `deno task compile` → 単一バイナリ

## 開発コマンド

```bash
deno task dev -- list              # 直接実行
deno task dev -- -d 7 -s           # フラグ付き実行
deno task compile                  # バイナリビルド
deno check ccs.ts                  # 型チェック
```

## アーキテクチャ原則

- sessions-index.json は読み取り専用。絶対に書き込まない
- JSOLNファイルも読み取り専用（agent-name 抽出のみ）
- メタデータ書き込みは atomic write（.tmp → rename）
- parse 失敗は個別スキップ、全体を落とさない
- CJK文字幅を正しく計算してテーブル整列

## コード構成（ccs.ts 内部）

- 型定義: SessionEntry, SessionMeta, SessionView
- データ読み込み: loadAllSessionIndexes(), loadMetadata(), extractAgentName()
- マージ・検索: mergeSessions(), resolveSession()（曖昧なら失敗）
- コマンド: cmdList, cmdStar, cmdTag, cmdUntag, cmdArchive, cmdResume, cmdInfo, cmdProjects, cmdDoctor, cmdGc
- 表示: renderTable()（CJK対応）, renderGrouped(), renderJson()
- クリップボード: pbcopy（失敗時は標準出力フォールバック）

## 注意事項

- `Co-Authored-By` トレーラーをコミットに入れない（Contributor表示を避けるため）
- README は日本語で記述
- 設計ドキュメント: `~/Develop/studio-prairie/docs/superpowers/specs/2026-04-15-ccs-session-manager-design.md`

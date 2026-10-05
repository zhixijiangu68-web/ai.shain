# AI社員 (ai.shain)

GitHub の Issue に仕事を書くと、AI社員がコードを読んで修正し、Pull Request を出します。
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk)（Claude Code と同じエージェント）を GitHub Actions 上で動かしています。

## 仕事の頼み方

- Issue に **`ai-task`** ラベルを付ける
- または Issue に **`@ai-shain`** を含むコメントを書く（追加の指示もそのまま伝わります）

AI社員は作業後、下書き (draft) の PR を作って Issue にリンクを書き込みます。
変更しなかった場合は、理由と確認したい点を Issue にコメントします。

## 使う側のリポジトリでの設定

1. [`examples/ai-shain.yml`](examples/ai-shain.yml) を `.github/workflows/ai-shain.yml` にコピー
2. **Settings → Secrets and variables → Actions** に `ANTHROPIC_API_KEY` を登録
3. **Settings → Actions → General → Workflow permissions** で
   「Allow GitHub Actions to create and approve pull requests」にチェック
4. リポジトリに `ai-task` ラベルを作成

ai.shain リポジトリが private の場合は、ai.shain 側の **Settings → Actions → General → Access** で
「Accessible from repositories owned by the user」を選んでください。

## 設定できる項目

| 入力 | 既定値 | 説明 |
|---|---|---|
| `model` | `claude-opus-5-5` | 使用するモデル |
| `max_turns` | `60` | エージェントの最大ターン数 |
| `max_budget_usd` | `5` | 1 回の作業の上限金額 (USD) |

対象リポジトリに `CLAUDE.md` があれば、AI社員はそれを読んで規約に従います。
「テストは `npm test` で実行」「コメントは日本語」など、AI社員への業務マニュアルとして書いておくと効果的です。

## 安全のための設計

- エージェントは git の commit / push を行わず、GitHub トークンも渡されません。push と PR 作成は Action 側のスクリプトが行います。
- コメントでの起動はリポジトリの OWNER / MEMBER / COLLABORATOR に限定しています。
- PR は draft で作成されるので、人がレビューしてからマージしてください。
- `GITHUB_TOKEN` で作られた PR では CI が自動起動しません。CI を走らせたい場合は PR を一度 Ready for review にするか、GitHub App / PAT のトークンを `github_token` に渡してください。

## ローカルでの動作確認

```sh
npm ci
GITHUB_EVENT_PATH=event.json TARGET_DIR=/path/to/repo SUMMARY_FILE=summary.md npm start
```

`event.json` の例: `{"issue":{"number":1,"title":"README を追加","body":"簡単な README.md を作って","html_url":""}}`

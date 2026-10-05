// AI社員: GitHub の Issue を読み、対象リポジトリのコードを修正する。
// git のコミット・push・PR 作成は action.yml 側で行い、エージェントには任せない。
import { readFileSync, writeFileSync } from "node:fs";
import { query } from "@anthropic-ai/claude-agent-sdk";

type IssueEvent = {
  issue?: { number: number; title: string; body: string | null; html_url: string };
  comment?: { body: string; user: { login: string } };
};

const env = (name: string, fallback?: string): string => {
  const value = process.env[name] || fallback;
  if (value === undefined) throw new Error(`環境変数 ${name} が設定されていません`);
  return value;
};

if (!process.env.ANTHROPIC_API_KEY) {
  throw new Error("ANTHROPIC_API_KEY が空です。リポジトリの Settings → Secrets and variables → Actions に登録してください");
}

const targetDir = env("TARGET_DIR", process.env.GITHUB_WORKSPACE);
const event: IssueEvent = JSON.parse(readFileSync(env("GITHUB_EVENT_PATH"), "utf8"));
const summaryFile = env("SUMMARY_FILE");

if (!event.issue) throw new Error("issues / issue_comment イベントから起動してください");
const { issue, comment } = event;

const prompt = `あなたはこのリポジトリを担当するエンジニアです。次の GitHub Issue に対応してください。

## Issue #${issue.number}: ${issue.title}
${issue.body ?? "(本文なし)"}
${comment ? `\n## 追加の指示 (@${comment.user.login} のコメント)\n${comment.body}\n` : ""}
## 進め方
1. まずリポジトリの構成と関連コードを読み、既存の書き方・規約を把握する。
2. Issue の要求を満たす最小限の変更を行う。無関係なリファクタリングはしない。
3. テスト・lint・型チェックなどリポジトリにある確認手段があれば実行し、通ることを確かめる。
4. git の commit / push / ブランチ操作は行わない（後工程で自動実行される）。
5. 要求が曖昧で判断できない場合は、変更せずに確認したい点をまとめる。

最後のメッセージは PR 本文としてそのまま使われます。日本語の Markdown で
「## 概要」「## 変更内容」「## 確認したこと」の見出しで簡潔に書いてください。
変更しなかった場合はその理由と確認したい点を書いてください。`;

let summary = "";
let failed = false;

try {
  for await (const message of query({
    prompt,
    options: {
      cwd: targetDir,
      model: env("MODEL", "claude-opus-5-5"),
      maxTurns: Number(env("MAX_TURNS", "60")),
      maxBudgetUsd: Number(env("MAX_BUDGET_USD", "5")),
      // 対象リポジトリの CLAUDE.md や .claude/settings.json を読み込む
      settingSources: ["project"],
      systemPrompt: { type: "preset", preset: "claude_code" },
      // CI 上で人の承認なしに動かすため、使えるツールを明示的に許可する
      permissionMode: "dontAsk",
      allowedTools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "TodoWrite"],
      disallowedTools: ["WebFetch", "WebSearch"],
    },
  })) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") console.log(block.text);
        else if (block.type === "tool_use") console.log(`🔧 ${block.name} ${JSON.stringify(block.input).slice(0, 200)}`);
      }
    } else if (message.type === "result") {
      console.log(`\n--- 完了: ${message.subtype} / ${message.num_turns} ターン / $${message.total_cost_usd.toFixed(2)}`);
      if (message.subtype === "success" && !message.is_error) {
        summary = message.result;
      } else {
        failed = true;
        summary = `AI社員の作業が途中で終了しました (\`${message.subtype}\`)。ログを確認してください。`;
      }
    }
  }
} catch (error) {
  console.error(error);
  failed = true;
  summary ||= "AI社員の作業中にエラーが発生しました。ログを確認してください。";
}

writeFileSync(summaryFile, `${summary}\n`);
if (failed) process.exitCode = 1;

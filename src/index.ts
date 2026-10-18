// AI社員: GitHub の Issue を読み、対象リポジトリで仕事をする。
// 1回目は「担当」が仕事をし、2回目は「チェック担当」が差分を読んで直し、PR 本文を仕上げる。
// git のコミット・push・PR 作成は action.yml 側で行い、エージェントには任せない。
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { buildReviewPrompt, buildWorkPrompt, detectKind, findManual, statsFooter, type Comment, type Issue, type PassStats } from "./prompt.js";

type IssueEvent = { issue?: Issue; comment?: Comment };

const env = (name: string, fallback?: string): string => {
  const value = process.env[name] || fallback;
  if (value === undefined) throw new Error(`環境変数 ${name} が設定されていません`);
  return value;
};
const flag = (name: string, fallback: boolean): boolean => {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return /^(true|1|yes|on)$/i.test(v);
};

// GitHub Actions 上では API キー（または Claude Code の OAuth トークン）が要る。
// 手元で動かすときは、Claude Code にログイン済みならそのまま動くので、ここでは止めない。
if (process.env.GITHUB_ACTIONS === "true" && !process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
  throw new Error("ANTHROPIC_API_KEY が空です。リポジトリの Settings → Secrets and variables → Actions に登録してください");
}

const targetDir = env("TARGET_DIR", process.env.GITHUB_WORKSPACE);
const event: IssueEvent = JSON.parse(readFileSync(env("GITHUB_EVENT_PATH"), "utf8"));
const summaryFile = env("SUMMARY_FILE");
const model = env("MODEL", "claude-opus-5-5");
const maxTurns = Number(env("MAX_TURNS", "60"));
const maxBudgetUsd = Number(env("MAX_BUDGET_USD", "5"));
const allowWeb = flag("ALLOW_WEB", false);
const review = flag("REVIEW", true);
const reviewMaxTurns = Number(env("REVIEW_MAX_TURNS", "40"));
const reviewBudgetUsd = Number(env("REVIEW_BUDGET_USD", "3"));

// Issue のないイベント（schedule・workflow_dispatch）では、JOB_TITLE / JOB_BODY を仕事として受ける
if (!event.issue && process.env.JOB_TITLE) {
  event.issue = { number: 0, title: process.env.JOB_TITLE, body: process.env.JOB_BODY ?? null, labels: (process.env.JOB_LABELS ?? "").split(",").filter(Boolean).map(name => ({ name })) };
}
if (!event.issue) throw new Error("issues / issue_comment イベントから起動するか、JOB_TITLE（と JOB_BODY）を渡してください");
const { issue, comment } = event;
const kind = detectKind(issue);
const manual = findManual(targetDir, process.env.MANUAL);

console.log(issue.number ? `Issue #${issue.number}: ${issue.title}` : `定期の仕事: ${issue.title}`);
console.log(`仕事の種類: ${kind} ／ 業務マニュアル: ${manual ? manual.path : "なし"} ／ Web: ${allowWeb ? "可" : "不可"} ／ チェック: ${review ? "あり" : "なし"}`);

// CI 上で人の承認なしに動かすため、使えるツールを明示的に許可する。
const baseTools = ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"];
const webTools = ["WebSearch", "WebFetch"];

type PassResult = PassStats & { ok: boolean; text: string };

async function runPass(name: string, prompt: string, limits: { maxTurns: number; maxBudgetUsd: number }): Promise<PassResult> {
  const result: PassResult = { name, ok: false, text: "", turns: 0, cost: 0, subtype: "error_during_execution" };
  console.log(`\n===== ${name}：開始（最大 ${limits.maxTurns} ターン・$${limits.maxBudgetUsd}）=====`);
  try {
    for await (const message of query({
      prompt,
      options: {
        cwd: targetDir,
        model,
        maxTurns: limits.maxTurns,
        maxBudgetUsd: limits.maxBudgetUsd,
        // 対象リポジトリの CLAUDE.md や .claude/settings.json を読み込む
        settingSources: ["project"],
        systemPrompt: { type: "preset", preset: "claude_code" },
        permissionMode: "dontAsk",
        allowedTools: allowWeb ? [...baseTools, ...webTools] : baseTools,
        disallowedTools: allowWeb ? [] : webTools,
      },
    })) {
      if (message.type === "system" && message.subtype === "init") {
        console.log(`[${name}] 使えるツール: ${message.tools.join(", ")}`);
      } else if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text") console.log(`[${name}] ${block.text}`);
          else if (block.type === "tool_use") console.log(`[${name}] 🔧 ${block.name} ${JSON.stringify(block.input).slice(0, 200)}`);
        }
      } else if (message.type === "result") {
        result.turns = message.num_turns;
        result.cost = message.total_cost_usd;
        result.subtype = message.subtype;
        console.log(`\n--- ${name}：${message.subtype} / ${message.num_turns} ターン / $${message.total_cost_usd.toFixed(2)}`);
        if (message.subtype === "success" && !message.is_error) {
          result.ok = true;
          result.text = message.result;
        }
      }
    }
  } catch (error) {
    console.error(error);
  }
  return result;
}

/** 作業ツリーに変更があるか（git があれば）。 */
function hasChanges(): boolean {
  try {
    return execFileSync("git", ["status", "--porcelain"], { cwd: targetDir, encoding: "utf8" }).trim().length > 0;
  } catch {
    return true;
  }
}

const passes: PassStats[] = [];
let summary = "";
let failed = false;

const work = await runPass("担当", buildWorkPrompt({ issue, comment, manual, kind, allowWeb }), { maxTurns, maxBudgetUsd });
passes.push(work);
if (work.ok) {
  summary = work.text;
} else {
  failed = true;
  summary = `AI社員（担当）の作業が途中で終了しました (\`${work.subtype}\`)。ログを確認してください。`;
}

// 変更があれば、チェック担当が差分を読んで直し、PR 本文を仕上げる。
if (review && hasChanges()) {
  const checked = await runPass("チェック", buildReviewPrompt({ issue, comment, manual, kind, allowWeb, draft: summary }), { maxTurns: reviewMaxTurns, maxBudgetUsd: reviewBudgetUsd });
  passes.push(checked);
  if (checked.ok && checked.text.trim()) {
    summary = checked.text;
  } else {
    summary += `\n\n> チェック担当の実行が途中で終わりました (\`${checked.subtype}\`)。上は担当の報告のままで、チェックは済んでいません。`;
  }
} else if (review) {
  console.log("\n変更がないので、チェック担当は動かしません。");
}

writeFileSync(summaryFile, `${summary.trim()}\n\n${statsFooter(model, passes)}\n`);
console.log(`\n${statsFooter(model, passes)}`);
if (failed) process.exitCode = 1;

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildReviewPrompt, buildWorkPrompt, detectKind, findManual, statsFooter, type Issue } from "./prompt.js";

const issue = (title: string, labels: string[] = []): Issue => ({ number: 7, title, body: "本文", labels: labels.map(name => ({ name })) });

test("仕事の種類：ラベルの指定が最優先", () => {
  assert.equal(detectKind(issue("記事を追加: 転職について", ["ai-task", "ai-task:fix"])), "fix");
});

test("仕事の種類：タイトルの言葉から推測する", () => {
  assert.equal(detectKind(issue("記事を追加: 転職について")), "article");
  assert.equal(detectKind(issue("残す記事の文言を点検する")), "check");
  assert.equal(detectKind(issue("トップの崩れを直す")), "fix");
  assert.equal(detectKind(issue("README の説明を更新")), "docs");
  assert.equal(detectKind(issue("パズルゲームを追加")), "other");
});

test("業務マニュアル：指定の場所 → よくある置き場の順に探す", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-shain-"));
  assert.equal(findManual(dir), null);
  mkdirSync(join(dir, ".github"));
  writeFileSync(join(dir, ".github", "ai-shain.md"), "# マニュアル\n");
  assert.deepEqual(findManual(dir), { path: ".github/ai-shain.md", text: "# マニュアル\n" });
  writeFileSync(join(dir, "docs-manual.md"), "# 別の場所\n");
  assert.equal(findManual(dir, "docs-manual.md")?.path, "docs-manual.md");
  assert.equal(findManual(dir, "nothing.md")?.path, ".github/ai-shain.md");
});

test("担当の指示文：Issue・マニュアル・種類・Web の可否が入る", () => {
  const text = buildWorkPrompt({
    issue: issue("記事を追加: 転職について"),
    comment: { body: "常体で", user: { login: "owner" } },
    manual: { path: ".github/ai-shain.md", text: "## 最初に読むもの\n- CLAUDE.md" },
    kind: "article",
    allowWeb: false,
  });
  for (const needle of ["Issue #7: 記事を追加: 転職について", "追加の指示（@owner のコメント）", "常体で", ".github/ai-shain.md", "## 最初に読むもの", "記事・文章を書く／直す", "Web は使えない", "## 概要", "commit / push"]) {
    assert.ok(text.includes(needle), `missing: ${needle}`);
  }
  assert.ok(buildWorkPrompt({ issue: issue("x"), manual: null, kind: "other", allowWeb: true }).includes("Web の検索と取得は使ってよい"));
  assert.ok(buildWorkPrompt({ issue: issue("x"), manual: null, kind: "other", allowWeb: true }).includes("業務マニュアル（`.github/ai-shain.md`）がない"));
});

test("チェック担当の指示文：担当の報告と、差分を読む手順が入る", () => {
  const text = buildReviewPrompt({ issue: issue("記事を追加"), manual: null, kind: "article", allowWeb: false, draft: "## 概要\n書いた" });
  for (const needle of ["チェック担当", "## 担当の報告", "書いた", "git diff", "## チェック", "commit / push"]) {
    assert.ok(text.includes(needle), `missing: ${needle}`);
  }
});

test("費用の一行", () => {
  const line = statsFooter("claude-opus-5-5", [
    { name: "担当", turns: 42, cost: 1.234, subtype: "success" },
    { name: "チェック", turns: 10, cost: 0.5, subtype: "error_max_turns" },
  ]);
  assert.equal(line, "AI社員：担当 42ターン・$1.23 ／ チェック 10ターン・$0.50（error_max_turns）（claude-opus-5-5）");
});

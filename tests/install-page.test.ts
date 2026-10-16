import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 연수용 '설치 따라하기' 페이지(docs/설치_따라하기.html, 같은 내용이 claude.ai 페이지로도 올라가 있음)는
// README의 Deploy 버튼과 같은 주소를 써야 합니다. Deploy 버튼 주소를 바꾸면 이 파일(과 claude.ai 페이지)도 함께 고치세요.
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const page = readFileSync(new URL("../docs/설치_따라하기.html", import.meta.url), "utf8");

test("설치 따라하기 페이지의 Deploy 주소는 README의 Deploy 버튼과 같다", () => {
  const fromReadme = readme.match(/https:\/\/vercel\.com\/new\/clone[^)\s]*/)?.[0];
  const fromPage = page.match(/https:\/\/vercel\.com\/new\/clone[^"\s]*/)?.[0];
  assert.ok(fromReadme && fromPage);
  assert.equal(fromPage, fromReadme);
});

test("설치 따라하기 파일은 혼자 열어도 한글이 깨지지 않게 문서 머리(charset)를 갖고 있다", () => {
  assert.match(page, /^<!doctype html>\n<html lang="ko">\n<head>\n<meta charset="utf-8">/);
  assert.ok(!page.includes("sk-or-v1-") || page.includes("sk-or-v1-…"), "실제 API 키가 들어 있으면 안 됩니다");
});

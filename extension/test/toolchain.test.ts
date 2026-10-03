import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

test("jsdom parses html so adapter tests can run offline", () => {
  const dom = new JSDOM(`<div role="log"><p>hello</p></div>`);
  const log = dom.window.document.querySelector('[role="log"]');
  assert.equal(log?.textContent, "hello");
});

const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

// AGENTS.md：版本号只有一处。扩展那一处是 manifest.json（Chrome 读的就是它）；
// package.json 只能跟着它走，不许各说各话。
test("package.json carries the same version as the manifest chrome reads", () => {
  assert.equal(pkg.version, manifest.version);
});

// H：`https://*/*` 正是 Chrome「在所有网站上」一键授予的那个模式。一次授权就让
// 自动注入读取用户打开的每一个 https 页面——没有绕过同意，但爆炸半径远超设计。
test("optional host permissions name specific sites, never every https page", () => {
  const origins: string[] = manifest.optional_host_permissions ?? [];
  assert.ok(origins.length > 0, "至少要有一个目标站点");
  for (const pattern of origins) {
    assert.ok(!pattern.includes("<all_urls>"), `${pattern} 是全网通配`);
    const host = pattern.replace(/^https:\/\//, "").replace(/\/\*$/, "");
    assert.ok(!host.includes("*"), `${pattern} 的主机名里有通配符，等于「所有网站」`);
    assert.ok(host.includes("."), `${pattern} 不是一个具体域名`);
  }
});

test("no host permissions are granted up front", () => {
  assert.equal(manifest.host_permissions, undefined,
    "站点权限必须是 optional_host_permissions，由用户在面板上逐站授予");
});

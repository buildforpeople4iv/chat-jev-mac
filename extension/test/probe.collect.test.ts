import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  findMessageContainers, describeElement, anonymize, redactToken,
} from "../src/probe/collect.ts";

const CHAT = `
<main>
  <div role="log" class="msg-list">
    <div class="row in"><span class="who">Ana</span><span class="body">hey are you around</span></div>
    <div class="row in"><span class="who">Ana</span><span class="body">need the doc today</span></div>
    <div class="row out"><span class="body">on it</span></div>
  </div>
  <div class="composer"><div contenteditable="true"></div></div>
</main>`;

test("ranks the repeated-children container above its wrappers", () => {
  const doc = new JSDOM(CHAT).window.document;
  const found = findMessageContainers(doc);
  assert.ok(found.length > 0);
  assert.equal(found[0]!.selector, '[role="log"]');
  assert.equal(found[0]!.childCount, 3);
});

test("reports the container element itself, not just a label for it", () => {
  // 消费者必须拿到元素。把 selector 字符串塞回 querySelector 有两种已复现的失败：
  // 非法选择器抛 SyntaxError，以及同形状多个元素时解析回第一个而不是打分最高的那个。
  const doc = new JSDOM(CHAT).window.document;
  const found = findMessageContainers(doc);
  assert.equal(found[0]!.element, doc.querySelector('[role="log"]'));
});

test("an explicit message log outranks a longer conversation list", () => {
  // WhatsApp 形状：25 行会话列表 + 4 行消息区。只按 childCount 排序会选中侧栏。
  const rows = Array.from({ length: 25 }, (_, i) =>
    `<div class="contact"><span>Contact ${i}</span></div>`).join("");
  const doc = new JSDOM(`
    <div id="pane-side">${rows}</div>
    <div id="main"><div role="log" class="msg-list">
      <div class="row in"><span>hey</span></div>
      <div class="row in"><span>you there</span></div>
      <div class="row out"><span>yes</span></div>
    </div></div>`).window.document;
  const found = findMessageContainers(doc);
  assert.equal(found[0]!.selector, '[role="log"]');
  assert.equal(found[0]!.childCount, 3);
  // 侧栏仍然进候选列表（诊断要能看到它），只是不在第一位
  assert.ok(found.some((c) => c.selector === "#pane-side"), "侧栏仍应作为候选被报告");
});

test("the reported selector is a redacted label, never raw page text", () => {
  const doc = new JSDOM(`
    <div id="chat-with-+15551234567">
      <div class="row in"><span>hey</span></div>
      <div class="row in"><span>you there</span></div>
    </div>`).window.document;
  const found = findMessageContainers(doc);
  assert.ok(!found[0]!.selector.includes("15551234567"), "选择器把电话号码带出来了");
  assert.equal(found[0]!.selector, "#<len:22>");
});

test("redactToken keeps structural names and hides content-shaped ones", () => {
  assert.equal(redactToken("pane-side"), "pane-side");
  assert.equal(redactToken("_ak72"), "_ak72");
  assert.equal(redactToken("row-1"), "row-1");
  assert.equal(redactToken("not-real!"), "<len:9>");
  assert.equal(redactToken("a".repeat(80)), "<len:80>");
  // 长数字串是账号/电话/会话号，不是结构名——即便形状完全合法也不外带
  assert.equal(redactToken("chat-15551234567"), "<len:16>");
  assert.equal(redactToken("1099511627776"), "<len:13>");
});

test("reports the signals an adapter will need", () => {
  const doc = new JSDOM(CHAT).window.document;
  const row = doc.querySelector(".row.in")!;
  const shape = describeElement(row);
  assert.deepEqual(shape.classes, ["row", "in"]);
  assert.equal(shape.tag, "div");
  assert.equal(shape.text, "Ana hey are you around");
});

test("anonymize replaces text but keeps structure and attributes", () => {
  const doc = new JSDOM(CHAT).window.document;
  const html = anonymize(doc.querySelector('[role="log"]')!);
  assert.ok(html.includes('class="row in"'), "结构属性必须保留");
  assert.ok(!html.includes("need the doc today"), "正文必须脱敏");
  assert.ok(/[a-z]{3,}/.test(html), "脱敏后仍要有占位文字，长度可比对");
});

test("anonymize also scrubs attribute values and comments, not just text nodes", () => {
  const doc = new JSDOM(`
    <div role="log" class="msg-list">
      <div class="row in" title="Ana: hey are you around" aria-label="message from Ana">
        <!-- Ana said: need the doc today -->
        <span class="body">hi</span>
      </div>
    </div>`).window.document;
  const html = anonymize(doc.querySelector('[role="log"]')!);
  assert.ok(!html.includes("hey are you around"), "title 属性也必须脱敏");
  assert.ok(!html.includes("message from Ana"), "aria-label 属性也必须脱敏");
  assert.ok(!html.includes("need the doc today"), "HTML 注释也必须脱敏");
  assert.ok(html.includes('class="row in"'), "允许字面保留的结构属性不受影响");
});

test("anonymize scrubs the breadth of free-text attributes while structural selectors survive", () => {
  const doc = new JSDOM(`
    <div role="log" id="log1" data-testid="msg-list" class="msg-list">
      <div class="row in" data-qa="row-1">
        <img class="avatar" alt="altsecrettext" />
        <input class="composer-echo" placeholder="placeholdersecrettext" value="valuesecrettext" />
        <span class="body" data-pre-plain-text="datastarsecrettext">hi</span>
      </div>
    </div>`).window.document;
  const html = anonymize(doc.querySelector('[role="log"]')!);

  // free-text-bearing attributes must be scrubbed, not just title/aria-label
  assert.ok(!html.includes("altsecrettext"), "alt 属性必须脱敏");
  assert.ok(!html.includes("placeholdersecrettext"), "placeholder 属性必须脱敏");
  assert.ok(!html.includes("valuesecrettext"), "value 属性必须脱敏");
  assert.ok(!html.includes("datastarsecrettext"), "任意 data-* 属性（如 data-pre-plain-text）必须脱敏");

  // selector-relevant structural attributes must survive literally
  assert.ok(html.includes('id="log1"'), "id 必须保留");
  assert.ok(html.includes('data-testid="msg-list"'), "data-testid 必须保留");
  assert.ok(html.includes('data-qa="row-1"'), "data-qa 必须保留");
  assert.ok(html.includes('class="row in"'), "class 必须保留");
  assert.ok(html.includes('role="log"'), "role 必须保留");
});

test("anonymize scrubs text hidden inside <template> content, not just childNodes", () => {
  const doc = new JSDOM(`
    <div class="row in">
      <span class="body">hi</span>
      <template id="rowTpl"><span class="secret">REALCHATTEXT-template</span></template>
    </div>`).window.document;
  const html = anonymize(doc.querySelector(".row.in")!);
  assert.ok(!html.includes("REALCHATTEXT-template"), "template content 也必须脱敏，不能原样带出");
  assert.ok(html.includes('id="rowTpl"'), "template 自身的结构属性不受影响");
});

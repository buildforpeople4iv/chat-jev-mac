import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { genericAdapter, LayoutChangedError, type Measure } from "../src/adapters/generic.ts";
import { pickAdapter } from "../src/adapters/registry.ts";
import { validateSnapshot, newestIncoming } from "../src/contracts/snapshot.ts";

// 左右分栏（WhatsApp / Telegram 这一类）
const BUBBLES = `
<main>
  <div role="log" class="msg-list">
    <div class="row in"><span class="who">Ana</span><span class="body">hey are you around</span></div>
    <div class="row in"><span class="who">Ana</span><span class="body">need the doc today</span></div>
    <div class="row out"><span class="body">on it</span></div>
  </div>
  <div class="composer"><div contenteditable="true"></div></div>
</main>`;

// 全左对齐（Slack / Discord 这一类）：靠名字区分，几何无差别
const FLAT = `
<main>
  <div role="log" class="msg-list">
    <div class="row"><b class="who">Ana</b><span class="body">can you take this</span></div>
    <div class="row"><b class="who">Ana</b><span class="body">before EOD please</span></div>
    <div class="row"><b class="who">Me</b><span class="body">sure</span></div>
  </div>
  <textarea class="composer"></textarea>
</main>`;

function docOf(html: string, url?: string): Document {
  return new JSDOM(`<body>${html}</body>`, url ? { url } : {}).window.document;
}

// 视口 1440，左边一条 430px 的会话列表——真实站点的消息容器**从来不**从视口 0 开始，
// 夹具必须编码这一点：容器原点为 0 的夹具会把「忘了减容器左边缘」的 bug 一起编码进测试。
const WINDOW_W = 1440;
const DEFAULT_SIDEBAR = 430;

/** 容器内的相对位置（0..1）换算成视口绝对坐标，跟 getBoundingClientRect 一个口径。 */
function boxAt(a: number, b: number, sidebar: number): { left: number; right: number; width: number } {
  const width = WINDOW_W - sidebar;
  return { left: sidebar + a * width, right: sidebar + b * width, width: (b - a) * width };
}

/** 气泡布局：对方贴容器左缘、自己贴右缘，容器本身从 sidebar 处起算。 */
function bubbleMeasureAt(sidebar: number): Measure {
  return (el) => {
    if (el.classList.contains("out")) return boxAt(0.70, 0.98, sidebar);
    if (el.classList.contains("row")) return boxAt(0.02, 0.40, sidebar);
    return boxAt(0, 1, sidebar);
  };
}
const bubbleMeasure = bubbleMeasureAt(DEFAULT_SIDEBAR);

// 全左对齐：所有行几何相同，横跨大半个容器
const flatMeasure: Measure = (el) =>
  el.classList.contains("row") ? boxAt(0.02, 0.88, DEFAULT_SIDEBAR)
                               : boxAt(0, 1, DEFAULT_SIDEBAR);

test("reads every message row out of a bubble layout", () => {
  const snap = genericAdapter.readSnapshot(docOf(BUBBLES), bubbleMeasure);
  assert.equal(snap.messages.length, 3);
  assert.equal(validateSnapshot(snap).ok, true);
});

test("geometry tells incoming from outgoing in a bubble layout", () => {
  const snap = genericAdapter.readSnapshot(docOf(BUBBLES), bubbleMeasure);
  assert.deepEqual(snap.messages.map((m) => m.isSelf), [false, false, true]);
});

// A：几何判定必须在容器坐标系里做。侧栏宽度一变方向就变，说明刻度整体偏移了——
// 实测偏移后 430px（WhatsApp/Slack 量级）全部判不出、600px（Discord/Teams）全判成自己发的，
// 即扩展在任何有会话列表的真实站点上都认不出对方消息。
for (const sidebar of [0, 200, 430, 600]) {
  test(`direction survives a ${sidebar}px conversation sidebar`, () => {
    const snap = genericAdapter.readSnapshot(docOf(BUBBLES), bubbleMeasureAt(sidebar));
    assert.deepEqual(snap.messages.map((m) => m.isSelf), [false, false, true],
      `侧栏 ${sidebar}px 时方向判定错了`);
    assert.match(newestIncoming(snap)!.text, /need the doc/);
  });
}

test("the reply target is the last incoming message", () => {
  const snap = genericAdapter.readSnapshot(docOf(BUBBLES), bubbleMeasure);
  assert.match(newestIncoming(snap)!.text, /need the doc/);
});

test("a flat layout yields unconfirmed direction rather than a guess", () => {
  const snap = genericAdapter.readSnapshot(docOf(FLAT), flatMeasure);
  assert.deepEqual(snap.messages.map((m) => m.isSelf), [null, null, null]);
});

test("an unconfirmed-direction conversation offers no reply target", () => {
  const snap = genericAdapter.readSnapshot(docOf(FLAT), flatMeasure);
  assert.equal(newestIncoming(snap), null);
});

test("an empty page reports a layout change instead of an empty conversation", () => {
  assert.throws(() => genericAdapter.readSnapshot(docOf("<main></main>"), bubbleMeasure),
    LayoutChangedError);
});

test("the composer is detected in both layouts", () => {
  assert.equal(genericAdapter.readSnapshot(docOf(BUBBLES), bubbleMeasure).input.canFill, true);
  assert.equal(genericAdapter.readSnapshot(docOf(FLAT), flatMeasure).input.canFill, true);
});

// ---------------------------------------------------------------------------
// B：容器启发式不能选中联系人列表
// ---------------------------------------------------------------------------

// WhatsApp 形状：左边 25 行会话列表，右边 4 行消息区。只按 childCount 排序会选中侧栏，
// 于是「消息」读出来是联系人预览文本，还会被当作待判断的消息发给大模型。
const WITH_SIDEBAR = `
<div id="app">
  <div id="pane-side">
    ${Array.from({ length: 25 }, (_, i) =>
      `<div class="contact"><span class="name">Contact ${i}</span><span class="preview">preview ${i}</span></div>`,
    ).join("\n    ")}
  </div>
  <div id="main">
    <div role="log" class="msg-list">
      <div class="row in"><span class="body">hey are you around</span></div>
      <div class="row in"><span class="body">need the doc today</span></div>
      <div class="row in"><span class="body">today please</span></div>
      <div class="row out"><span class="body">on it</span></div>
    </div>
    <div class="composer"><div contenteditable="true"></div></div>
  </div>
</div>`;

test("a 25-row contact sidebar does not outrank the 4-row message log", () => {
  const snap = genericAdapter.readSnapshot(docOf(WITH_SIDEBAR), bubbleMeasure);
  assert.equal(snap.messages.length, 4, "读到的行数说明选中的是侧栏而不是消息区");
  assert.ok(!snap.messages.some((m) => m.text.includes("Contact")), "读出的是联系人预览，不是消息");
  assert.match(newestIncoming(snap)!.text, /today please/);
});

// ---------------------------------------------------------------------------
// C：容器句柄必须是元素本身，不能把展示用的选择器字符串塞回 querySelector
// ---------------------------------------------------------------------------

test("a container whose id is not a legal selector still reads and still diagnoses", () => {
  // `#1099511627776` 不是合法选择器，旧代码在 readSnapshot 和 diagnose 里双双抛 SyntaxError,
  // 而 content.ts 的契约是 diagnose() 永不抛——扩展死掉的同时用户唯一的报错渠道也死了。
  const doc = docOf(`<main><div id="1099511627776" class="msg-list">
    <div class="row in"><span class="body">hey are you around</span></div>
    <div class="row out"><span class="body">on it</span></div>
  </div></main>`);
  const snap = genericAdapter.readSnapshot(doc, bubbleMeasure);
  assert.equal(snap.messages.length, 2);
  const d = genericAdapter.diagnose(doc, bubbleMeasure);
  assert.equal(d.rowCount, 2);
});

test("with two role=log elements the adapter reads the one that scored best", () => {
  // querySelector('[role="log"]') 返回的是文档里第一个，打分选中的是第二个。
  const doc = docOf(`<main>
    <div role="log" class="side-log">
      <div class="note in"><span class="body">sidebar noise one</span></div>
      <div class="note in"><span class="body">sidebar noise two</span></div>
    </div>
    <div role="log" class="msg-list">
      <div class="row in"><span class="body">hey are you around</span></div>
      <div class="row in"><span class="body">need the doc today</span></div>
      <div class="row out"><span class="body">on it</span></div>
    </div>
  </main>`);
  const snap = genericAdapter.readSnapshot(doc, bubbleMeasure);
  assert.equal(snap.messages.length, 3);
  assert.ok(!snap.messages.some((m) => m.text.includes("sidebar noise")), "读的是第一个 role=log，不是打分最高的那个");
});

// ---------------------------------------------------------------------------
// E：会话标识要含 hash / search
// ---------------------------------------------------------------------------

test("the conversation id follows a hash-routed chat switch", () => {
  const a = genericAdapter.readSnapshot(
    docOf(BUBBLES, "https://web.telegram.org/k/#-1001234"), bubbleMeasure);
  const b = genericAdapter.readSnapshot(
    docOf(BUBBLES, "https://web.telegram.org/k/#-1009999"), bubbleMeasure);
  assert.notEqual(a.conversationId, b.conversationId, "hash 里的会话切换必须改变 conversationId");
  assert.equal(a.conversationId, "/k/#-1001234");
});

test("the conversation id follows a query-routed chat switch", () => {
  const a = genericAdapter.readSnapshot(
    docOf(BUBBLES, "https://example.test/chat?c=1"), bubbleMeasure);
  const b = genericAdapter.readSnapshot(
    docOf(BUBBLES, "https://example.test/chat?c=2"), bubbleMeasure);
  assert.notEqual(a.conversationId, b.conversationId);
});

// ---------------------------------------------------------------------------
// F：messageId 在虚拟滚动裁掉顶部行之后必须稳定
// ---------------------------------------------------------------------------

test("the newest incoming message keeps its id when the list is trimmed at the top", () => {
  const doc = docOf(`<main><div role="log" class="msg-list">
    <div class="row in"><span class="body">first</span></div>
    <div class="row in"><span class="body">second</span></div>
    <div class="row in"><span class="body">third</span></div>
    <div class="row in"><span class="body">hey are you around</span></div>
  </div></main>`);
  const before = newestIncoming(genericAdapter.readSnapshot(doc, bubbleMeasure))!;

  // Slack / Discord / Teams 的虚拟滚动：顶部行被丢出 DOM
  const log = doc.querySelector('[role="log"]')!;
  log.removeChild(log.children[0]!);
  log.removeChild(log.children[0]!);

  const after = newestIncoming(genericAdapter.readSnapshot(doc, bubbleMeasure))!;
  assert.equal(after.text, before.text);
  assert.equal(after.id, before.id, "顶部裁剪后同一条消息拿到了新 id，去重会失效");
});

// ---------------------------------------------------------------------------
// diagnose
// ---------------------------------------------------------------------------

test("diagnose reports the container, row count and direction source", () => {
  const d = genericAdapter.diagnose(docOf(BUBBLES), bubbleMeasure);
  assert.equal(d.containerSelector, '[role="log"]');
  assert.equal(d.rowCount, 3);
  assert.equal(d.directionSignal, "geometry");
  assert.deepEqual(d.counts, { self: 1, them: 2, unknown: 0 });
  assert.equal(d.inputFound, true);
  assert.equal(d.inputKind, "contenteditable");
});

test("diagnose reports none as the direction source for a flat layout", () => {
  const d = genericAdapter.diagnose(docOf(FLAT), flatMeasure);
  assert.equal(d.directionSignal, "none");
  assert.deepEqual(d.counts, { self: 0, them: 0, unknown: 3 });
  assert.equal(d.inputKind, "textarea");
});

// K1：只有一侧解析出来时不能自称 "geometry"——那正是刻度偏移或单列布局的样子。
test("diagnose calls a one-sided reading weak, not geometry", () => {
  const doc = docOf(`<main><div role="log" class="msg-list">
    <div class="row in"><span class="body">hey are you around</span></div>
    <div class="row in"><span class="body">need the doc today</span></div>
  </div></main>`);
  const d = genericAdapter.diagnose(doc, bubbleMeasure);
  assert.deepEqual(d.counts, { self: 0, them: 2, unknown: 0 });
  assert.equal(d.directionSignal, "weak");
});

test("diagnose never leaks message text", () => {
  const d = genericAdapter.diagnose(docOf(BUBBLES), bubbleMeasure);
  const dumped = JSON.stringify(d);
  for (const secret of ["hey are you around", "need the doc today", "on it", "Ana"]) {
    assert.ok(!dumped.includes(secret), `诊断泄漏了正文：${secret}`);
  }
  assert.ok(d.rowShapes.every((s) => typeof s.textLength === "number"));
});

// D：选择器字符串本身也是一条外泄通道——诊断被 README 承诺为「可安全分享」。
test("diagnose does not carry a phone number out inside a selector", () => {
  for (const id of ["chat-with-+15551234567", "chat-15551234567", "15551234567"]) {
    const doc = docOf(`<main><div id="${id}" class="msg-list">
      <div class="row in"><span class="body">hey</span></div>
      <div class="row out"><span class="body">ok</span></div>
    </div></main>`);
    const dumped = JSON.stringify(genericAdapter.diagnose(doc, bubbleMeasure));
    assert.ok(!dumped.includes("15551234567"), `选择器把电话号码带出来了：${id}`);
    assert.ok(dumped.includes("<len:"), "脱敏后应当留下长度标记");
  }
});

test("diagnose keeps an identifier-shaped id literal so an adapter can still be written", () => {
  const doc = docOf(`<main><div id="pane-side" class="msg-list">
    <div class="row in"><span class="body">hey</span></div>
    <div class="row out"><span class="body">ok</span></div>
  </div></main>`);
  const d = genericAdapter.diagnose(doc, bubbleMeasure);
  assert.equal(d.containerSelector, "#pane-side");
});

test("diagnose redacts aria-label values but keeps the key", () => {
  const doc = docOf(`<main><div role="log" class="msg-list">
    <div class="row in" aria-label="Ana said hey are you around"><span class="body">hey</span></div>
    <div class="row in" aria-label="Ana said need the doc"><span class="body">doc</span></div>
  </div></main>`);
  const dumped = JSON.stringify(genericAdapter.diagnose(doc, bubbleMeasure));
  assert.ok(!dumped.includes("hey are you around"), "aria-label 的值泄漏了正文");
  assert.ok(dumped.includes("aria-label"), "aria-label 这个键本身要保留");
});

test("diagnose redacts non-selector data-* values but keeps data-testid literal", () => {
  // WhatsApp's own real markup carries the contact name and a timestamp in
  // `data-pre-plain-text` — a data-* attribute, not aria-label, but just as
  // much a leak if copied verbatim.
  const doc = docOf(`<main><div role="log" class="msg-list">
    <div class="row in" data-pre-plain-text="[10:32, 1/1/2024] Ana Smith: " data-testid="row-1"><span class="body">hey</span></div>
    <div class="row in" data-pre-plain-text="[10:33, 1/1/2024] Ana Smith: " data-testid="row-2"><span class="body">doc</span></div>
  </div></main>`);
  const dumped = JSON.stringify(genericAdapter.diagnose(doc, bubbleMeasure));
  assert.ok(!dumped.includes("Ana Smith"), "data-pre-plain-text 的值泄漏了联系人名/正文");
  assert.ok(dumped.includes("data-pre-plain-text"), "data-pre-plain-text 这个键本身要保留");
  assert.ok(dumped.includes("row-1"), "data-testid 是选择器要用的字面值，应当照抄");
});

test("diagnose redacts a structural attribute value that carries a phone number", () => {
  const doc = docOf(`<main><div role="log" class="msg-list">
    <div class="row in" aria-labelledby="peer-15551234567"><span class="body">hey</span></div>
    <div class="row in" aria-labelledby="peer-15551234567"><span class="body">doc</span></div>
  </div></main>`);
  const dumped = JSON.stringify(genericAdapter.diagnose(doc, bubbleMeasure));
  assert.ok(!dumped.includes("15551234567"), "aria-labelledby 指向的 id 把电话号码带出来了");
  assert.ok(dumped.includes("aria-labelledby"), "键本身要保留");
});

test("diagnose keeps identifier-shaped class tokens but redacts content-shaped ones", () => {
  const longToken = "a".repeat(80);
  const doc = docOf(`<main><div role="log" class="msg-list">
    <div class="row message-out _ak72 not-real! ${longToken}"><span class="body">hey</span></div>
    <div class="row in"><span class="body">doc</span></div>
  </div></main>`);
  const d = genericAdapter.diagnose(doc, bubbleMeasure);
  const classes = d.rowShapes[0]!.classes;
  assert.ok(classes.includes("row"), "普通标识符形态的 class 应当照抄");
  assert.ok(classes.includes("message-out"), "普通标识符形态的 class 应当照抄");
  assert.ok(classes.includes("_ak72"), "哈希形态但仍是合法标识符的 class 应当照抄");
  assert.ok(!classes.includes("not-real!"), "含非标识符字符的 class 应当脱敏");
  assert.ok(classes.includes(`<len:9>`), "含非标识符字符的 class 应当脱敏为长度");
  assert.ok(!classes.includes(longToken), "超长 class 应当脱敏");
  assert.ok(classes.includes(`<len:80>`), "超长 class 应当脱敏为长度");
});

test("diagnose reports bounded descendant structure without leaking descendant attribute values", () => {
  // On real sites the direction/sender marker frequently lives on a nested
  // wrapper (Slack's sender-metadata node, WhatsApp's tail/avatar wrapper),
  // not the row itself — secrets are planted at three depths plus one past
  // the cap, on attributes known to carry real content on real sites.
  const doc = docOf(`<main><div role="log" class="msg-list">
    <div class="row in">
      <span class="wrap" data-pre-plain-text="SECRET_D1_ana_smith">
        <b class="who" aria-label="SECRET_D2_hey_there">
          <i class="tail" data-secretattr="SECRET_D3_need_the_doc">
            <u class="deep" data-secretattr="SECRET_D4_should_not_appear">x</u>
          </i>
        </b>
      </span>
    </div>
    <div class="row in"><span class="body">hi</span></div>
  </div></main>`);
  const d = genericAdapter.diagnose(doc, bubbleMeasure);
  const dumped = JSON.stringify(d);
  for (const secret of [
    "SECRET_D1_ana_smith",
    "SECRET_D2_hey_there",
    "SECRET_D3_need_the_doc",
    "SECRET_D4_should_not_appear",
  ]) {
    assert.ok(!dumped.includes(secret), `descendant 属性值泄漏了：${secret}`);
  }
  const descendants = d.rowShapes[0]!.descendants;
  const tags = descendants.map((s) => s.tag);
  assert.ok(tags.includes("span"), "depth 1 的 descendant 应当出现");
  assert.ok(tags.includes("b"), "depth 2 的 descendant 应当出现");
  assert.ok(tags.includes("i"), "depth 3 的 descendant 应当出现");
  assert.ok(!tags.includes("u"), "depth 4 超出上限，不应出现");
  assert.ok(
    descendants.some((s) => "data-pre-plain-text" in s.attrs),
    "data-pre-plain-text 这个键本身要保留",
  );
  assert.ok(
    descendants.some((s) => "aria-label" in s.attrs),
    "aria-label 这个键本身要保留",
  );
});

test("pickAdapter falls back to the generic adapter for any url", () => {
  assert.equal(pickAdapter("https://web.whatsapp.com/").id, "generic");
  assert.equal(pickAdapter("https://app.slack.com/client/T1/C1").id, "generic");
});

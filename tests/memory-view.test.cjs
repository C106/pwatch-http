const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const view = require("../memory-view.js");
const expressions = require("../address-expression.js");

test("module-relative address expressions support arithmetic using the backend base", async () => {
  const api = async () => ({ address: "0x1000" });
  assert.equal(await expressions.resolve(1, "libgame.so + 0x1234 - 0x34", api), "0x0000000000002200");
  assert.equal(await expressions.resolve(1, "/data/app/libgame.so+20", api), "0x0000000000001020");
  assert.equal(expressions.resolve(1, "0x10 + 0x10", api), "0x0000000000000020");
  await assert.rejects(expressions.resolve(1, "missing.so + 1", async () => { throw new Error("Module not found"); }), /Module not found/);
  await assert.rejects(expressions.resolve(1, "libgame.so - 0x2000", api), /exceeds/);
});

test("64-bit address validation and size limits", () => {
  assert.equal(view.request("123", "0X20000000000001", "256").addr, "0x0020000000000001");
  assert.equal(view.request(123, "ff", 1).addr, "0x00000000000000ff");
  for (const addr of ["", "-1", "xyz", "10000000000000000", "0x"]) assert.throws(() => view.address(addr));
  for (const pid of [0, -1, 2147483648, 1.5, ""]) assert.throws(() => view.request(pid, "0", 1));
  for (const size of [0, 4097, -1, 1.5]) assert.throws(() => view.request(1, "0", size));
  assert.throws(() => view.request(1, "ffffffffffffffff", 2));
  assert.equal(view.request(1, "ffffffffffffffff", 1).size, 1);
});

test("paging is precise and stops at both address boundaries", () => {
  const query = view.request(1, "20000000000001", 256);
  assert.equal(view.page(query, 1).addr, "0x0020000000000101");
  assert.deepEqual(view.page(view.page(query, 1), -1), query);
  assert.equal(view.page(view.request(1, "0", 256), -1), null);
  assert.equal(view.page(view.request(1, "10", 256), -1).addr, view.hex(0n));
  const last = view.page(view.request(1, "ffffffffffffffed", 16), 1);
  assert.equal(last.addr, "0xfffffffffffffffd");
  assert.equal(last.size, 3);
  assert.equal(view.page(last, 1), null);
});

test("hex and ASCII preserve partial rows and non-printable bytes", () => {
  const data = [0, 32, 65, 126, 127, 255, ...Array(10).fill(1), 66];
  const rows = view.rows("20000000000001", data);
  assert.equal(rows[0].ascii, ". A~............");
  assert.equal(rows[0].hex.length, 47);
  assert.equal(rows[1].addr, "0x0020000000000011");
  assert.equal(rows[1].hex, "42".padEnd(47));
  assert.equal(rows[1].ascii, "B");
});

test("rejects malformed, mismatched and truncated API results", () => {
  const query = view.request(1, "10", 2);
  const body = { ...query, data: [1, 255] };
  assert.equal(view.validateResponse(body, query).length, 1);
  for (const patch of [{ addr: "20" }, { addr: 16 }, { pid: 2 }, { size: 1 }, { data: [1] }, { data: [0, 256] }, { data: [0, "ff"] }]) {
    assert.throws(() => view.validateResponse({ ...body, ...patch }, query));
  }
});

// Minimal DOM adapter tests the same rendering/event code used by the page.
class Element {
  value = ""; text = ""; children = []; disabled = false; checked = false; className = ""; attributes = {}; events = {};
  get textContent() { return this.text + this.children.map(child => child.textContent).join(""); }
  set textContent(value) { this.text = value; this.children = []; }
  classList = { toggle() {}, remove: name => { this.className = this.className.split(" ").filter(value => value !== name).join(" "); } };
  append(...children) { for (const child of children) this.children.push(...(child.fragment ? child.children : [child])); }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, handler) { this.events[name] = handler; }
  fire(name) { return this.events[name]({ preventDefault() {} }); }
}
function harness(api, resolver) {
  const elements = {};
  const doc = {
    hidden: false,
    events: {},
    addEventListener(name, handler) { this.events[name] = handler; },
    querySelector(id) { return elements[id] ||= new Element(); },
    createElement() { return new Element(); },
    createDocumentFragment() { const e = new Element(); e.fragment = true; return e; },
  };
  const controller = view.create(doc, api, resolver);
  const el = name => elements[`#memory${name}`];
  return { controller, el, doc };
}
function response(path, data) {
  const params = new URL(path, "http://localhost").searchParams;
  return { pid: Number(params.get("pid")), addr: params.get("addr"), size: Number(params.get("size")), data };
}

test("read, next, refresh, safe text rendering, PID reset", async () => {
  const calls = [];
  const { controller, el } = harness(async (path, options) => {
    calls.push(path);
    assert.equal(options.cache, "no-store");
    return response(path, [60, 62]);
  });
  el("Pid").value = "42"; el("Addr").value = "20000000000001"; el("Size").value = "2";
  await el("Form").fire("submit");
  assert.match(calls[0], /^\/memory\/read\?/);
  assert.equal(el("Rows").children[0].children[2].textContent, "<>");
  assert.equal(el("Next").disabled, false);
  await el("Next").fire("click");
  assert.equal(el("Addr").value, "0x0020000000000003");
  await el("Refresh").fire("click");
  assert.equal(calls[1], calls[2]);
  controller.setPid(43);
  assert.equal(el("Rows").children.length, 0);
  assert.equal(el("Refresh").disabled, true);
});

test("memory form resolves a module expression before requesting bytes", async () => {
  const calls = [];
  const { controller, el } = harness(async (path) => { calls.push(path); return response(path, [60, 62]); }, async () => "0x0000000000001020");
  el("Pid").value = "42"; el("Addr").value = "libgame.so + 0x20"; el("Size").value = "2";
  await el("Form").fire("submit");
  assert.match(calls[0], /addr=0x0000000000001020/);
  assert.equal(el("Addr").value, "0x0000000000001020");
  assert.match(el("Status").textContent, /Resolved libgame\.so \+ 0x20/);
  controller.reset();
});

test("memory module resolution uses the PID and shares cancellation with memory reads", async () => {
  const pending = [];
  const reads = [];
  const api = (path, options) => {
    if (path.startsWith("/processes/")) return new Promise(resolve => pending.push({ path, options, resolve }));
    reads.push(path);
    return Promise.resolve(response(path, [65, 66]));
  };
  const { controller, el } = harness(api, (pid, addr, options) => expressions.resolve(pid, addr, api, options));
  el("Pid").value = "42"; el("Addr").value = "libgame.so+20-10"; el("Size").value = "2";
  const first = el("Form").fire("submit");
  assert.equal(el("Read").disabled, true);
  assert.match(pending[0].path, /^\/processes\/42\/resolve\?/);
  controller.setPid(43);
  assert.equal(pending[0].options.signal.aborted, true);
  const second = el("Form").fire("submit");
  pending[1].resolve({ address: "20000000000001" }); await second;
  pending[0].resolve({ address: "1000" }); await first;
  assert.equal(reads.length, 1);
  assert.match(reads[0], /pid=43&addr=0x0020000000000011/);
  await el("Next").fire("click");
  await el("Refresh").fire("click");
  assert.equal(pending.length, 2); // Paging and refresh keep the absolute address.
});

test("failed memory resolution never reads bytes and keeps expression for retry", async () => {
  const { el } = harness(async () => { assert.fail("Must not read memory"); }, async () => { throw new Error("module not found"); });
  el("Pid").value = "42"; el("Addr").value = "missing.so"; el("Size").value = "2";
  await el("Form").fire("submit");
  assert.match(el("Status").textContent, /module not found/);
  assert.equal(el("Addr").value, "missing.so");
  assert.equal(el("Read").disabled, false);
  assert.equal(el("Rows").children.length, 0);
});

test("driver errors clear stale data and re-enable Read", async () => {
  const { controller, el } = harness(async () => { throw new Error("ioctl 601 failed: Bad address"); });
  await controller.open(1, "10");
  assert.match(el("Status").textContent, /ioctl 601/);
  assert.equal(el("Rows").children.length, 0);
  assert.equal(el("Read").disabled, false);
  assert.equal(el("Next").disabled, true);
});

test("old responses never overwrite a new PID/address or endpoint", async () => {
  const pending = [];
  const { controller, el } = harness((path, options) => new Promise(resolve => pending.push({ path, options, resolve })));
  const first = controller.open(1, "10", "12");
  const second = controller.open(2, "20", "22");
  assert.equal(pending[0].options.signal.aborted, true);
  pending[1].resolve(response(pending[1].path, [65, 66]));
  await second;
  pending[0].resolve(response(pending[0].path, [0, 0]));
  await first;
  assert.equal(el("Rows").children[0].children[2].textContent, "AB");
  assert.match(el("Status").textContent, /PID 2/);
  controller.reset();
  assert.equal(el("Rows").children.length, 0);
});

const settle = () => new Promise(resolve => setImmediate(resolve));
function changedSpans(el) {
  return el("Rows").children.flatMap(row => row.children.flatMap(cell => cell.children))
    .filter(span => span.className === "memory-changed");
}

test("refresh highlights only changed bytes in hex and ASCII for 500ms", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let data = [...Array(16).fill(65), 0];
  const { controller, el } = harness(async path => response(path, [...data]));
  await controller.open(1, "20000000000001", "20000000000012");
  assert.equal(changedSpans(el).length, 0);
  el("View").scrollTop = 123;
  el("View").scrollLeft = 45;
  data[0] = 60; data[16] = 1;
  await el("Refresh").fire("click");
  assert.equal(changedSpans(el).length, 4);
  assert.equal(el("Rows").children[0].children[2].textContent, "<" + "A".repeat(15));
  assert.equal(el("Rows").children[1].children[1].textContent.length, 47);
  assert.match(changedSpans(el)[2].title, /0x0020000000000011: 00/);
  assert.equal(el("View").scrollTop, 123);
  assert.equal(el("View").scrollLeft, 45);
  t.mock.timers.tick(499);
  assert.equal(changedSpans(el).length, 4);
  t.mock.timers.tick(1);
  assert.equal(changedSpans(el).length, 0);
  await el("Refresh").fire("click");
  assert.equal(changedSpans(el).length, 0);
  assert.match(el("Status").textContent, /0 changed/);
  data[0] = 65;
  await el("Refresh").fire("click");
  assert.equal(changedSpans(el).length, 2); // Compare to previous success, not the first read.
  controller.reset();
});

test("auto refresh waits 500ms, never overlaps slow reads, and stops when unchecked", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = [];
  let finish;
  const { controller, el } = harness(path => {
    calls.push(path);
    if (calls.length > 1) return new Promise(resolve => { finish = () => resolve(response(path, [66, 67])); });
    return Promise.resolve(response(path, [65, 66]));
  });
  await controller.open(42, "10", "12");
  el("Auto").checked = true;
  el("Auto").fire("change");
  t.mock.timers.tick(499);
  assert.equal(calls.length, 1);
  t.mock.timers.tick(1);
  assert.equal(calls.length, 2);
  assert.equal(el("Rows").children[0].children[2].textContent, "AB");
  t.mock.timers.tick(2000);
  assert.equal(calls.length, 2);
  finish(); await settle();
  assert.equal(changedSpans(el).length, 4);
  assert.equal(calls[0], calls[1]);
  t.mock.timers.tick(500);
  assert.equal(calls.length, 3);
  el("Auto").checked = false;
  el("Auto").fire("change");
  finish(); await settle();
  t.mock.timers.tick(3000);
  assert.equal(calls.length, 3);
  controller.reset();
});

test("auto refresh pauses for inactive tabs and hidden documents", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const { controller, el, doc } = harness(async path => { calls++; return response(path, [65, 66]); });
  el("Auto").checked = true;
  await controller.open(42, "10", "12");
  controller.setActive(false);
  t.mock.timers.tick(2000);
  assert.equal(calls, 1);
  controller.setActive(true);
  t.mock.timers.tick(500); await settle();
  assert.equal(calls, 2);
  doc.hidden = true; doc.events.visibilitychange();
  t.mock.timers.tick(2000);
  assert.equal(calls, 2);
  doc.hidden = false; doc.events.visibilitychange();
  t.mock.timers.tick(500); await settle();
  assert.equal(calls, 3);
  controller.reset();
  t.mock.timers.tick(2000);
  assert.equal(calls, 3);
});

test("address edits abort in-flight polling and discard stale bytes and comparison baseline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0, finish, signal;
  const { controller, el } = harness((path, options) => {
    calls++;
    if (calls === 2) return new Promise(resolve => { signal = options.signal; finish = () => resolve(response(path, [1, 2])); });
    return Promise.resolve(response(path, calls === 1 ? [65, 66] : [67, 68]));
  });
  el("Auto").checked = true;
  await controller.open(42, "10", "12");
  t.mock.timers.tick(500);
  el("Addr").value = "20";
  el("Addr").fire("input");
  assert.equal(signal.aborted, true);
  await el("Form").fire("submit");
  finish(); await settle();
  assert.equal(changedSpans(el).length, 0);
  assert.equal(el("Rows").children[0].children[2].textContent, "CD");
  controller.setPid(43);
  t.mock.timers.tick(3000);
  assert.equal(calls, 3);
});

test("polling errors stop auto refresh and do not retain stale data", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const { controller, el } = harness(async path => {
    if (++calls > 1) throw new Error("ioctl 601 failed");
    return response(path, [65, 66]);
  });
  el("Auto").checked = true;
  await controller.open(42, "10", "12");
  t.mock.timers.tick(500); await settle();
  assert.equal(el("Auto").checked, false);
  assert.match(el("Status").textContent, /ioctl 601 failed.*Auto refresh stopped/);
  assert.equal(el("Rows").children.length, 0);
  assert.equal(el("Read").disabled, false);
  t.mock.timers.tick(3000);
  assert.equal(calls, 2);
});

test("HTML includes all view controls and loads helper before app", () => {
  const html = readFileSync(new URL("../index.html", `file://${__filename}`), "utf8");
  for (const name of ["Form", "Pid", "Addr", "Size", "Read", "Prev", "Next", "Refresh", "Auto", "Status", "Rows", "View"]) {
    assert.equal(html.split(`id="memory${name}"`).length, 2);
  }
  assert.match(html, /data-tab="memory"/);
  assert(html.indexOf('src="./memory-view.js"') < html.indexOf('src="./app.js"'));
});

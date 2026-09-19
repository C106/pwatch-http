const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const view = require("../memory-view.js");

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
  value = ""; textContent = ""; children = []; disabled = false; attributes = {}; events = {};
  classList = { toggle() {} };
  append(...children) { for (const child of children) this.children.push(...(child.fragment ? child.children : [child])); }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, handler) { this.events[name] = handler; }
  fire(name) { return this.events[name]({ preventDefault() {} }); }
}
function harness(api) {
  const elements = {};
  const doc = {
    querySelector(id) { return elements[id] ||= new Element(); },
    createElement() { return new Element(); },
    createDocumentFragment() { const e = new Element(); e.fragment = true; return e; },
  };
  const controller = view.create(doc, api);
  const el = name => elements[`#memory${name}`];
  return { controller, el };
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

test("HTML includes all view controls and loads helper before app", () => {
  const html = readFileSync(new URL("../index.html", `file://${__filename}`), "utf8");
  for (const name of ["Form", "Pid", "Addr", "Size", "Read", "Prev", "Next", "Refresh", "Status", "Rows", "View"]) {
    assert.equal(html.split(`id="memory${name}"`).length, 2);
  }
  assert.match(html, /data-tab="memory"/);
  assert(html.indexOf('src="./memory-view.js"') < html.indexOf('src="./app.js"'));
});

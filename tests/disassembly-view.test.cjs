const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const view = require("../disassembly-view.js");
const engine = require("../disassembler.js").instantiate(readFileSync(`${__dirname}/../vendor/capstone/capstone.wasm`));
const nop = [0x1f, 0x20, 0x03, 0xd5];

test("real ARM64 engine: instructions, branch targets and full-width addresses", async () => {
  const decode = await engine;
  const base = 0xffffffffff000000n;
  const result = decode([...nop, 0xc0, 0x03, 0x5f, 0xd6, 1, 0, 0, 0x14], base, "arm64");
  assert.deepEqual(result.rows.map(r => r.mnemonic), ["nop", "ret", "b"]);
  assert.equal(result.rows[2].addr, base + 8n);
  assert.equal(result.rows[2].operands, "#0xffffffffff00000c");
  assert.equal(result.consumed, 12);
  assert.throws(() => decode(nop, 1n, "arm64"), /aligned/);
});

test("real x86 engine: Intel syntax, relative branches, instruction-aligned pages", async () => {
  const decode = await engine;
  const result = decode([0x90, 0x48, 0x89, 0xe5, 0xc3], 0x20000000000001n, "x86_64", 2);
  assert.equal(result.consumed, 4);
  assert.equal(result.rows[1].addr, 0x20000000000002n);
  assert.equal(result.rows[1].mnemonic, "mov");
  assert.equal(result.rows[1].operands, "rbp, rsp");
  const branch = decode([0xeb, 0x02], 0xffffffffff000000n, "x86_64");
  assert.equal(branch.rows[0].operands, "0xffffffffff000004");
});

test("invalid and incomplete bytes stay visible and do not stop decoding", async () => {
  const decode = await engine;
  const result = decode([0xff, 0xff, 0xff, 0xff, ...nop, 1, 2], 0n, "arm64");
  assert.deepEqual(result.rows.map(r => r.mnemonic), [".byte", "nop", ".byte"]);
  assert.equal(result.rows[2].bytes.length, 2);
  assert.equal(result.consumed, 10);
  assert.equal(decode([0x0f], 0n, "x86_64").rows[0].invalid, true);
  assert.throws(() => decode([256], 0n, "x86_64"));
  assert.throws(() => decode([0x90, 0x90], 0xffffffffffffffffn, "x86_64"));
});

test("repeated decoding frees native allocations", async () => {
  const decode = await engine;
  for (let i = 0; i < 1000; i++) assert.equal(decode(nop, 0n, "arm64").rows[0].mnemonic, "nop");
});

test("validates architecture, alignment and limits; lookahead respects region/u64 bounds", () => {
  const input = { pid: 1, addr: "20000000000000", size: 256, arch: "arm64" };
  assert.equal(view.request(input).readSize, 259);
  assert.equal(view.request({ ...input, arch: "x86_64", size: 4082 }).readSize, 4096);
  const query = view.request({ ...input, addr: "10", end: "19" });
  assert.equal(query.readSize, 9);
  assert.equal(query.size, 9);
  assert.equal(view.nextPage(query, 9), null);
  for (const patch of [{ arch: "arm" }, { addr: "11" }, { size: 4083 }, { pid: 0 }, { end: "10" }]) {
    assert.throws(() => view.request({ ...input, ...patch }));
  }
  const last = view.request({ ...input, addr: "fffffffffffffffc", size: 4 });
  assert.equal(last.readSize, 4);
  assert.equal(view.nextPage(last, 4), null);
});

class Element {
  value = ""; textContent = ""; children = []; disabled = false; attributes = {}; events = {};
  classList = { toggle() {} };
  append(...children) { for (const child of children) this.children.push(...(child.fragment ? child.children : [child])); }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, handler) { this.events[name] = handler; }
  fire(name) { return this.events[name]({ preventDefault() {} }); }
}
function harness(api, decoder = () => engine, actions) {
  const elements = {};
  const doc = {
    querySelector(id) { return elements[id] ||= new Element(); },
    createElement() { return new Element(); },
    createDocumentFragment() { const e = new Element(); e.fragment = true; return e; },
  };
  const controller = view.create(doc, api, decoder, actions);
  const el = name => elements[`#disasm${name}`];
  el("Arch").value = "arm64";
  el("Size").value = "256";
  return { controller, el };
}
function response(path, bytes = nop) {
  const p = new URL(path, "http://localhost").searchParams;
  const size = Number(p.get("size"));
  return { pid: Number(p.get("pid")), addr: p.get("addr"), size, data: Array.from({ length: size }, (_, i) => bytes[i % bytes.length]) };
}

test("read, next, previous and refresh retain instruction boundaries and map limits", async () => {
  const calls = [];
  const { controller, el } = harness(async (path, options) => {
    calls.push(path);
    assert.equal(options.cache, "no-store");
    return response(path);
  });
  await controller.open(42, "20000000000000", "20000000000204");
  assert.equal(el("Rows").children.length, 64);
  assert.equal(el("Prev").disabled, true);
  await el("Next").fire("click");
  assert.equal(el("Addr").value, "0x0020000000000100");
  await el("Prev").fire("click");
  assert.equal(calls[0], calls[2]);
  await el("Next").fire("click");
  await el("Next").fire("click");
  assert.equal(el("Rows").children.length, 1);
  assert.equal(el("Next").disabled, true);
  await el("Refresh").fire("click");
  assert.equal(calls[4], calls[5]);
  controller.setPid(43);
  assert.equal(el("Rows").children.length, 0);
  assert.equal(el("Prev").disabled, true);
});

test("manual x86 page uses lookahead and supports execution breakpoint preparation", async () => {
  const actions = [];
  const { el } = harness(async path => response(path, [0x48, 0x89, 0xe5]), () => engine,
    { breakpoint: (...args) => actions.push(args) });
  el("Pid").value = "42"; el("Addr").value = "20000000000001";
  el("Arch").value = "x86_64"; el("Size").value = "1";
  await el("Form").fire("submit");
  el("Rows").children[0].children[4].children[0].fire("click");
  assert.deepEqual(actions, [[42, "0x0020000000000001"]]);
  await el("Next").fire("click");
  assert.equal(el("Addr").value, "0x0020000000000004");
  el("Arch").fire("change");
  assert.equal(el("Rows").children.length, 0);
  assert.equal(el("Next").disabled, true);
});

test("failed or malformed reads show errors without stale instructions", async () => {
  for (const api of [async () => { throw new Error("ioctl 601 failed"); }, async path => ({ ...response(path), data: [1] })]) {
    const { controller, el } = harness(api);
    await controller.open(1, "10");
    assert.match(el("Status").textContent, /failed|Invalid memory response/);
    assert.equal(el("Rows").children.length, 0);
    assert.equal(el("Read").disabled, false);
    assert.equal(el("Next").disabled, true);
  }
});

test("read timeout aborts the API and restores controls", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { controller, el } = harness((path, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("Timed out", "AbortError")));
  }));
  const read = controller.open(1, "10");
  assert.equal(el("Read").disabled, true);
  t.mock.timers.tick(15000);
  await read;
  assert.match(el("Status").textContent, /timed out/);
  assert.equal(el("Read").disabled, false);
  assert.equal(el("Rows").children.length, 0);
});

test("engine failure is recoverable and text is rendered without HTML interpretation", async () => {
  let failed = true;
  const { controller, el } = harness(async path => response(path), async () => {
    if (failed) throw new Error("Capstone download failed");
    return () => ({ rows: [{ addr: 0n, bytes: [1], mnemonic: "<nop>", operands: "<script>", invalid: true }], consumed: 1 });
  });
  await controller.open(1, "0");
  assert.match(el("Status").textContent, /Capstone download failed/);
  failed = false;
  await controller.open(1, "0");
  assert.equal(el("Rows").children[0].children[3].textContent, "<script>");
  assert.equal(el("Rows").children[0].children[4].children[0].disabled, true);
});

test("stale responses and pending engine initialization cannot overwrite resets", async () => {
  const pending = [];
  const { controller, el } = harness((path, options) => new Promise(resolve => pending.push({ path, options, resolve })));
  const first = controller.open(1, "10");
  const second = controller.open(2, "20");
  assert.equal(pending[0].options.signal.aborted, true);
  pending[1].resolve(response(pending[1].path)); await second;
  pending[0].resolve(response(pending[0].path)); await first;
  assert.match(el("Status").textContent, /PID 2/);
  let finish;
  let started;
  const loading = new Promise(resolve => { started = resolve; });
  const slow = harness(async path => response(path), () => { started(); return new Promise(resolve => { finish = resolve; }); });
  const read = slow.controller.open(1, "10");
  await loading;
  slow.controller.reset();
  finish(await engine); await read;
  assert.equal(slow.el("Rows").children.length, 0);
});

test("HTML includes controls, accessible icons and scripts in dependency order", () => {
  const html = readFileSync(`${__dirname}/../index.html`, "utf8");
  for (const name of ["Form", "Pid", "Addr", "Size", "Arch", "Read", "Prev", "Next", "Refresh", "Status", "Rows", "View"]) {
    assert.equal(html.split(`id="disasm${name}"`).length, 2);
  }
  assert.match(html, /data-tab="disasm"/);
  assert.match(html, /aria-label="Next instructions"/);
  const scripts = ["memory-view.js", "disassembler.js", "disassembly-view.js", "app.js"].map(s => html.indexOf(`src="./${s}"`));
  assert.deepEqual(scripts, [...scripts].sort((a, b) => a - b));
});

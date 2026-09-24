const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const view = require("../disassembly-view.js");
const engine = require("../disassembler.js").instantiate(
  readFileSync(`${__dirname}/../vendor/capstone/capstone.wasm`),
);
const nop = [0x1f, 0x20, 0x03, 0xd5];

test("real ARM64 engine: instructions, branch targets and full-width addresses", async () => {
  const decode = await engine;
  const base = 0xffffffffff000000n;
  const result = decode(
    [...nop, 0xc0, 0x03, 0x5f, 0xd6, 1, 0, 0, 0x14],
    base,
    "arm64",
  );
  assert.deepEqual(
    result.rows.map((r) => r.mnemonic),
    ["nop", "ret", "b"],
  );
  assert.equal(result.rows[2].addr, base + 8n);
  assert.equal(result.rows[2].operands, "#0xffffffffff00000c");
  assert.equal(result.consumed, 12);
  assert.throws(() => decode(nop, 1n, "arm64"), /aligned/);
});

test("real x86 engine: Intel syntax, relative branches, instruction-aligned pages", async () => {
  const decode = await engine;
  const result = decode(
    [0x90, 0x48, 0x89, 0xe5, 0xc3],
    0x20000000000001n,
    "x86_64",
    2,
  );
  assert.equal(result.consumed, 4);
  assert.equal(result.rows[1].addr, 0x20000000000002n);
  assert.equal(result.rows[1].mnemonic, "mov");
  assert.equal(result.rows[1].operands, "rbp, rsp");
  const branch = decode([0xeb, 0x02], 0xffffffffff000000n, "x86_64");
  assert.equal(branch.rows[0].operands, "0xffffffffff000004");
});

test("operand links use real ARM64 branch, address and literal-load targets", async () => {
  const decode = await engine;
  const base = 0xffffffffff000000n;
  for (const [bytes, expected] of [
    [[2, 0, 0, 0x14], base + 8n], // b
    [[2, 0, 0, 0x94], base + 8n], // bl
    [[0x40, 0, 0, 0x54], base + 8n], // b.eq
    [[0x40, 0, 0, 0xb4], base + 8n], // cbz
    [[0x40, 0, 0, 0x36], base + 8n], // tbz: bit number is not a link
    [[0x40, 0, 0, 0x10], base + 8n], // adr
    [[0, 0, 0, 0x90], base], // adrp
    [[0x40, 0, 0, 0x58], base + 8n], // ldr literal
  ]) {
    const row = decode(bytes, base, "arm64").rows[0];
    const target = view.operandTarget(row, "arm64");
    assert.equal(
      target?.addr,
      `0x${expected.toString(16)}`,
      `${row.mnemonic} ${row.operands}`,
    );
    assert.equal(
      row.operands.slice(target.start, target.end),
      `#0x${expected.toString(16)}`,
    );
  }
});

test("operand links use x86-64 direct, RIP/EIP-relative and absolute memory addresses", async () => {
  const decode = await engine;
  const base = 0xffffffffff000000n;
  for (const [bytes, expected] of [
    [[0xeb, 2], "0xffffffffff000004"],
    [[0xe8, 0, 0, 0, 0], "0xffffffffff000005"],
    [[0x48, 0x8b, 5, 0x10, 0, 0, 0], "0xffffffffff000017"],
    [[0x48, 0x8b, 5, 0xf0, 0xff, 0xff, 0xff], "0xfffffffffefffff7"],
    [[0x67, 0x48, 0x8b, 5, 0x10, 0, 0, 0], "0x00000000ff000018"],
    [[0x48, 0x8b, 4, 0x25, 0, 0x10, 0, 0], "0x0000000000001000"],
  ]) {
    const row = decode(bytes, base, "x86_64").rows[0];
    assert.equal(
      view.operandTarget(row, "x86_64")?.addr,
      expected,
      `${row.mnemonic} ${row.operands}`,
    );
  }
});

test("register-dependent addresses, immediates, invalid bytes and FS/GS offsets are not links", () => {
  for (const [arch, mnemonic, operands] of [
    ["arm64", "add", "x0, x0, #0x1000"],
    ["arm64", "ldr", "x0, [x1, #0x1000]"],
    ["arm64", "br", "x0"],
    ["x86_64", "movabs", "rax, 0x7000000000"],
    ["x86_64", "call", "rax"],
    ["x86_64", "mov", "rax, qword ptr [rbx + 0x1000]"],
    ["x86_64", "mov", "rax, qword ptr fs:[0x1000]"],
    ["x86_64", "mov", "rax, qword ptr gs:[rip + 0x1000]"],
  ])
    assert.equal(
      view.operandTarget({ mnemonic, operands, addr: 0n, bytes: [0] }, arch),
      null,
      operands,
    );
  assert.equal(
    view.operandTarget(
      { mnemonic: "b", operands: "#0x1000", invalid: true },
      "arm64",
    ),
    null,
  );
  assert.equal(
    view.operandTarget({ mnemonic: "b", operands: "#0" }, "arm64").addr,
    "0x0000000000000000",
  );
});

test("invalid and incomplete bytes stay visible and do not stop decoding", async () => {
  const decode = await engine;
  const result = decode([0xff, 0xff, 0xff, 0xff, ...nop, 1, 2], 0n, "arm64");
  assert.deepEqual(
    result.rows.map((r) => r.mnemonic),
    [".byte", "nop", ".byte"],
  );
  assert.equal(result.rows[2].bytes.length, 2);
  assert.equal(result.consumed, 10);
  assert.equal(decode([0x0f], 0n, "x86_64").rows[0].invalid, true);
  assert.throws(() => decode([256], 0n, "x86_64"));
  assert.throws(() => decode([0x90, 0x90], 0xffffffffffffffffn, "x86_64"));
});

test("repeated decoding frees native allocations", async () => {
  const decode = await engine;
  for (let i = 0; i < 1000; i++)
    assert.equal(decode(nop, 0n, "arm64").rows[0].mnemonic, "nop");
});

test("validates architecture, alignment and limits; lookahead respects region/u64 bounds", () => {
  const input = { pid: 1, addr: "20000000000000", size: 256, arch: "arm64" };
  assert.equal(view.request(input).readSize, 259);
  assert.equal(
    view.request({ ...input, arch: "x86_64", size: 4082 }).readSize,
    4096,
  );
  const query = view.request({ ...input, addr: "10", end: "19" });
  assert.equal(query.readSize, 9);
  assert.equal(query.size, 9);
  assert.equal(view.nextPage(query, 9), null);
  for (const patch of [
    { arch: "arm" },
    { addr: "11" },
    { size: 4083 },
    { pid: 0 },
    { end: "10" },
  ]) {
    assert.throws(() => view.request({ ...input, ...patch }));
  }
  const last = view.request({ ...input, addr: "fffffffffffffffc", size: 4 });
  assert.equal(last.readSize, 4);
  assert.equal(view.nextPage(last, 4), null);
});

class Element {
  value = "";
  textContent = "";
  children = [];
  disabled = false;
  attributes = {};
  events = {};
  classList = { toggle() {} };
  append(...children) {
    for (const child of children)
      this.children.push(...(child.fragment ? child.children : [child]));
  }
  replaceChildren(...children) {
    this.children = [];
    this.append(...children);
  }
  setAttribute(name, value) {
    this.attributes[name] = value;
  }
  addEventListener(name, handler) {
    this.events[name] = handler;
  }
  fire(name) {
    return this.events[name]({ preventDefault() {} });
  }
}
function harness(api, decoder = () => engine, actions, resolver) {
  const elements = {};
  const doc = {
    querySelector(id) {
      return (elements[id] ||= new Element());
    },
    createElement() {
      return new Element();
    },
    createDocumentFragment() {
      const e = new Element();
      e.fragment = true;
      return e;
    },
  };
  const controller = view.create(doc, api, decoder, actions, resolver);
  const el = (name) => elements[`#disasm${name}`];
  el("Arch").value = "arm64";
  el("Size").value = "256";
  return { controller, el };
}
function response(path, bytes = nop) {
  const p = new URL(path, "http://localhost").searchParams;
  const size = Number(p.get("size"));
  return {
    pid: Number(p.get("pid")),
    addr: p.get("addr"),
    size,
    data: Array.from({ length: size }, (_, i) => bytes[i % bytes.length]),
  };
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

test("operand jumps have independent back/forward history with page and scroll restoration", async () => {
  const { controller, el } = harness(async (path) =>
    response(path, [0, 4, 0, 0x14]),
  ); // b PC+0x1000
  await controller.open(42, "20000000000000", "20000000000200");
  await el("Next").fire("click");
  const source = el("Addr").value;
  el("View").scrollTop = 128;
  const link = el("Rows").children[0].children[3].children[1];
  assert.match(link.title, /Jump to 0x0020000000001100/);
  await link.fire("click");
  assert.equal(el("Addr").value, "0x0020000000001100");
  assert.equal(el("Prev").disabled, true);
  assert.equal(el("Back").disabled, false);
  assert.equal(el("History").children.length, 2);
  el("View").scrollTop = 64;
  await el("Back").fire("click");
  assert.equal(el("Addr").value, source);
  assert.equal(el("View").scrollTop, 128);
  assert.equal(el("Prev").disabled, false);
  assert.equal(el("Forward").disabled, false);
  await el("Forward").fire("click");
  assert.equal(el("Addr").value, "0x0020000000001100");
  assert.equal(el("View").scrollTop, 64);
  await el("Refresh").fire("click");
  assert.equal(el("History").children.length, 2);
  await el("Back").fire("click");
  await el("Prev").fire("click");
  assert.equal(el("Addr").value, "0x0020000000000000");
  assert.equal(el("Forward").disabled, true);
});

test("typed jumps preserve history, truncate forward visits, and restore entries from the menu", async () => {
  const { controller, el } = harness(async (path) => response(path));
  await controller.open(42, "1000");
  el("Addr").value = "2000";
  el("Addr").fire("input");
  await el("Form").fire("submit");
  assert.equal(el("History").children.length, 2);
  await el("Back").fire("click");
  el("Addr").value = "3000";
  el("Addr").fire("input");
  await el("Form").fire("submit");
  assert.equal(el("History").children.length, 2);
  assert.equal(el("Forward").disabled, true);
  el("History").value = "0";
  await el("History").fire("change");
  assert.equal(el("Addr").value, "0x0000000000001000");
  await el("Forward").fire("click");
  assert.equal(el("Addr").value, "0x0000000000003000");
  await el("Form").fire("submit");
  assert.equal(el("History").children.length, 2); // Same query is not duplicated.
  controller.setPid(43);
  assert.equal(el("Back").disabled, true);
  assert.equal(el("Forward").disabled, true);
  assert.equal(el("History").disabled, true);
});

test("failed jumps retain the last successful location and stale jumps do not create visits", async () => {
  let fail = false;
  let finish;
  const { controller, el } = harness((path) => {
    if (fail) throw new Error("unmapped target");
    if (
      new URL(path, "http://local").searchParams.get("addr") ===
      "0x0000000000003000"
    )
      return new Promise((resolve) => {
        finish = () => resolve(response(path));
      });
    return Promise.resolve(response(path));
  });
  await controller.open(42, "1000");
  fail = true;
  await controller.open(42, "2000");
  assert.match(el("Status").textContent, /unmapped target/);
  assert.equal(el("Back").disabled, false);
  assert.equal(el("History").children.length, 1);
  fail = false;
  await el("Back").fire("click");
  assert.equal(el("Addr").value, "0x0000000000001000");
  const stale = controller.open(42, "3000");
  assert.equal(el("Back").disabled, true);
  await controller.open(42, "4000");
  finish();
  await stale;
  assert.equal(el("Addr").value, "0x0000000000004000");
  assert.equal(el("History").children.length, 2);
  controller.reset();
  assert.equal(el("History").disabled, true);
});

test("history restores PID and architecture and stays bounded", async () => {
  const { controller, el } = harness(async (path) => response(path));
  await controller.open(42, "1000");
  await controller.open(43, "2001", null, "x86_64");
  await el("Back").fire("click");
  assert.equal(el("Pid").value, "42");
  assert.equal(el("Arch").value, "arm64");
  for (let i = 1; i < 103; i++)
    await controller.open(42, (4096 + i * 4).toString(16), null, "arm64");
  assert.equal(el("History").children.length, 100);
});

test("disassembly form resolves module arithmetic before reading", async () => {
  const calls = [];
  const { el } = harness(
    async (path) => {
      calls.push(path);
      return response(path);
    },
    () => engine,
    {},
    async () => "0x0020000000000020",
  );
  el("Pid").value = "42";
  el("Addr").value = "libgame.so - 0x10";
  el("Size").value = "16";
  await el("Form").fire("submit");
  assert.match(calls[0], /addr=0x0020000000000020/);
  assert.equal(el("Addr").value, "0x0020000000000020");
  assert.match(el("Status").textContent, /Resolved libgame\.so - 0x10/);
});

test("resolved disassembly addresses still enforce alignment and range before reading", async () => {
  for (const addr of ["0x101", "0xfffffffffffffffc"]) {
    const { el } = harness(
      async () => {
        assert.fail("Must not read memory");
      },
      () => engine,
      {},
      async () => addr,
    );
    el("Pid").value = "42";
    el("Addr").value = "libgame.so+1";
    await el("Form").fire("submit");
    assert.match(el("Status").textContent, /aligned|64-bit/);
    assert.equal(el("Read").disabled, false);
    assert.equal(el("Rows").children.length, 0);
  }
});

test("reset during module resolution prevents a stale disassembly read", async () => {
  let finish;
  let signal;
  const { controller, el } = harness(
    async () => {
      assert.fail("Must not read memory");
    },
    () => engine,
    {},
    (pid, addr, options) => {
      signal = options.signal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  );
  el("Pid").value = "42";
  el("Addr").value = "libgame.so";
  const read = el("Form").fire("submit");
  controller.reset();
  assert.equal(signal.aborted, true);
  finish("0x1000");
  await read;
  assert.equal(el("Addr").value, "libgame.so");
  assert.equal(el("Rows").children.length, 0);
});

test("manual x86 page uses lookahead and supports execution breakpoint preparation", async () => {
  const actions = [];
  const { el } = harness(
    async (path) => response(path, [0x48, 0x89, 0xe5]),
    () => engine,
    { breakpoint: (...args) => actions.push(args) },
  );
  el("Pid").value = "42";
  el("Addr").value = "20000000000001";
  el("Arch").value = "x86_64";
  el("Size").value = "1";
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
  for (const api of [
    async () => {
      throw new Error("ioctl 601 failed");
    },
    async (path) => ({ ...response(path), data: [1] }),
  ]) {
    const { controller, el } = harness(api);
    await controller.open(1, "10");
    assert.match(el("Status").textContent, /failed|Invalid memory response/);
    assert.equal(el("Rows").children.length, 0);
    assert.equal(el("Read").disabled, false);
    assert.equal(el("Next").disabled, true);
  }
});

test("read timeout aborts the API and restores controls", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { controller, el } = harness(
    (path, { signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener("abort", () =>
          reject(new DOMException("Timed out", "AbortError")),
        );
      }),
  );
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
  const { controller, el } = harness(
    async (path) => response(path),
    async () => {
      if (failed) throw new Error("Capstone download failed");
      return () => ({
        rows: [
          {
            addr: 0n,
            bytes: [1],
            mnemonic: "<nop>",
            operands: "<script>",
            invalid: true,
          },
        ],
        consumed: 1,
      });
    },
  );
  await controller.open(1, "0");
  assert.match(el("Status").textContent, /Capstone download failed/);
  failed = false;
  await controller.open(1, "0");
  assert.equal(el("Rows").children[0].children[3].textContent, "<script>");
  assert.equal(el("Rows").children[0].children[4].children[0].disabled, true);
});

test("stale responses and pending engine initialization cannot overwrite resets", async () => {
  const pending = [];
  const { controller, el } = harness(
    (path, options) =>
      new Promise((resolve) => pending.push({ path, options, resolve })),
  );
  const first = controller.open(1, "10");
  const second = controller.open(2, "20");
  assert.equal(pending[0].options.signal.aborted, true);
  pending[1].resolve(response(pending[1].path));
  await second;
  pending[0].resolve(response(pending[0].path));
  await first;
  assert.match(el("Status").textContent, /PID 2/);
  let finish;
  let started;
  const loading = new Promise((resolve) => {
    started = resolve;
  });
  const slow = harness(
    async (path) => response(path),
    () => {
      started();
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  );
  const read = slow.controller.open(1, "10");
  await loading;
  slow.controller.reset();
  finish(await engine);
  await read;
  assert.equal(slow.el("Rows").children.length, 0);
});

test("HTML includes controls, accessible icons and scripts in dependency order", () => {
  const html = readFileSync(`${__dirname}/../index.html`, "utf8");
  for (const name of [
    "Form",
    "Pid",
    "Addr",
    "Size",
    "Arch",
    "Read",
    "Prev",
    "Next",
    "Back",
    "Forward",
    "History",
    "Refresh",
    "Status",
    "Rows",
    "View",
  ]) {
    assert.equal(html.split(`id="disasm${name}"`).length, 2);
  }
  assert.match(html, /data-tab="disasm"/);
  assert.match(html, /aria-label="Next instructions"/);
  const scripts = [
    "address-expression.js",
    "memory-view.js",
    "disassembler.js",
    "disassembly-view.js",
    "app.js",
  ].map((s) => html.indexOf(`src="./${s}"`));
  assert.deepEqual(
    scripts,
    [...scripts].sort((a, b) => a - b),
  );
});

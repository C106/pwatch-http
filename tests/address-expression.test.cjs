const { test } = require("node:test");
const assert = require("node:assert/strict");
const expressions = require("../address-expression.js");

test("numeric arithmetic is hexadecimal, precise, left-to-right, and needs no API", () => {
  const api = () => { throw new Error("Unexpected API call"); };
  for (const [input, expected] of [
    [" 0X20000000000001 + 20 - 0x8 ", "0x0020000000000019"],
    ["ff+1-10", "0x00000000000000f0"],
    ["0xffffffffffffffff - 1 + 1", "0xffffffffffffffff"],
    ["0+10-10", "0x0000000000000000"],
  ]) assert.equal(expressions.resolve(42, input, api), expected);
  for (const input of ["0-1", "ffffffffffffffff+1", "0-1+1", "10000000000000000"]) {
    assert.throws(() => expressions.resolve(42, input, api), /64-bit/);
  }
});

test("module-only names, paths, hyphens and quoted names resolve the base on each jump", async () => {
  const calls = [];
  const signal = new AbortController().signal;
  const api = async (path, options) => {
    calls.push(new URL(path, "http://localhost"));
    assert.equal(options.signal, signal);
    assert.equal(options.cache, "no-store");
    return { address: "0xffffffffff000001", value: 18446744073692774401 };
  };
  for (const input of ["lib-game.so", "lib-game.so+20-8", "'/data/app/foo-123/lib game.so' + 20 - 8", '"lib-123"']) {
    const result = await expressions.resolve(42, input, api, { signal });
    assert.equal(result, input.includes("20") ? "0xffffffffff000019" : "0xffffffffff000001");
  }
  assert.equal(calls[0].pathname, "/processes/42/resolve");
  assert.equal(calls[0].searchParams.get("addr"), "lib-game.so + 0x0");
  assert.equal(calls[2].searchParams.get("addr"), "/data/app/foo-123/lib game.so + 0x0");
  assert.equal(calls[3].searchParams.get("addr"), "lib-123 + 0x0");
});

test("invalid expressions and PIDs never reach the API", () => {
  let calls = 0;
  const api = () => { calls++; };
  for (const input of ["", "-1", "+1", "0x", "0xGG", "10+", "10++20", "foo.so +", "foo.so + nope", '"foo.so', '"foo.so" + 0x', "1 * 2", "foo.so + 1; alert(1)"]) {
    assert.throws(() => expressions.resolve(1, input, api), input);
  }
  for (const pid of [0, -1, "", 2147483648, 1.5]) assert.throws(() => expressions.resolve(pid, "foo.so", api), /PID/);
  assert.equal(calls, 0);
});

test("module failures, malformed responses, unsigned overflow and cancellation propagate", async () => {
  await assert.rejects(expressions.resolve(42, "missing.so", async () => { throw new Error("module not found in pid 42 maps"); }), /module not found/);
  for (const body of [null, {}, { value: 123 }, { address: 123 }, { address: "xyz" }, { address: "0x10000000000000000" }]) {
    await assert.rejects(expressions.resolve(42, "foo.so", async () => body));
  }
  await assert.rejects(expressions.resolve(42, "foo.so-1", async () => ({ address: "0" })), /64-bit/);
  await assert.rejects(expressions.resolve(42, "foo.so+1", async () => ({ address: "ffffffffffffffff" })), /64-bit/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(expressions.resolve(42, "foo.so", async () => ({ address: "0" }), { signal: controller.signal }), { name: "AbortError" });
});

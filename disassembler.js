/* Capstone 5 wasm32 ABI adapter for the pinned binary in vendor/capstone. */
(function (root) {
  "use strict";
  const wasmUrl = typeof document !== "undefined"
    ? new URL("./vendor/capstone/capstone.wasm", document.currentScript.src) : null;
  let pending;

  async function instantiate(binary) {
    let memory;
    const { instance } = await WebAssembly.instantiate(binary, { a: {
      a() { throw new Error("Capstone ran out of memory."); },
      b(dest, src, size) { new Uint8Array(memory.buffer).copyWithin(dest, src, src + size); },
    } });
    const w = instance.exports;
    memory = w.c;
    w.d(); // __wasm_call_ctors initializes Capstone's allocator callbacks.
    const utf8 = new TextDecoder();
    function string(ptr, size) {
      const bytes = new Uint8Array(memory.buffer, ptr, size);
      const end = bytes.indexOf(0);
      return utf8.decode(end < 0 ? bytes : bytes.subarray(0, end));
    }
    function alloc(size) {
      const ptr = w.x(size);
      if (!ptr) throw new Error("Capstone ran out of memory.");
      return ptr;
    }
    return function decode(data, address, arch, limit = data.length) {
      if (!["arm64", "x86_64"].includes(arch)) throw new Error("Unsupported architecture.");
      if (!Array.isArray(data) || !data.length || data.length > 4096
        || !data.every(b => Number.isInteger(b) && b >= 0 && b <= 255)) throw new Error("Invalid instruction bytes.");
      if (typeof address !== "bigint" || address < 0n || address + BigInt(data.length) > (1n << 64n))
        throw new Error("Invalid instruction address.");
      if (arch === "arm64" && address % 4n) throw new Error("ARM64 addresses must be 4-byte aligned.");
      if (!Number.isInteger(limit) || limit < 1 || limit > data.length) throw new Error("Invalid page size.");
      let handlePtr = 0, codePtr = 0, resultPtr = 0, opened = false;
      try {
        handlePtr = alloc(4);
        const error = w.i(arch === "arm64" ? 1 : 3, arch === "arm64" ? 0 : 8, handlePtr);
        if (error) throw new Error(`Capstone initialization failed (${error}).`);
        opened = true;
        const handle = new DataView(memory.buffer).getUint32(handlePtr, true);
        codePtr = alloc(data.length);
        resultPtr = alloc(4);
        new Uint8Array(memory.buffer).set(data, codePtr);
        const rows = [];
        let offset = 0;
        while (offset < limit) {
          const count = w.l(handle, codePtr + offset, data.length - offset, address + BigInt(offset), 1, resultPtr);
          let size, mnemonic, operands, invalid = false;
          if (count) {
            const view = new DataView(memory.buffer);
            const insn = view.getUint32(resultPtr, true);
            try {
              // cs_insn: uint16 size at 16, bytes[24] at 18, mnemonic[32] at 42, op_str[160] at 74.
              size = view.getUint16(insn + 16, true);
              if (!size || size > data.length - offset) throw new Error("Invalid Capstone instruction size.");
              mnemonic = string(insn + 42, 32);
              operands = string(insn + 74, 160);
            } finally { w.m(insn, count); }
          } else {
            const error = w.g(handle);
            if (error) throw new Error(`Capstone decode failed (${error}).`);
            size = Math.min(arch === "arm64" ? 4 : 1, data.length - offset);
            mnemonic = ".byte";
            operands = "Invalid or incomplete instruction";
            invalid = true;
          }
          rows.push({ addr: address + BigInt(offset), bytes: data.slice(offset, offset + size), mnemonic, operands, invalid });
          offset += size;
        }
        return { rows, consumed: offset };
      } finally {
        if (opened) w.j(handlePtr);
        if (resultPtr) w.y(resultPtr);
        if (codePtr) w.y(codePtr);
        if (handlePtr) w.y(handlePtr);
      }
    };
  }

  function load() {
    if (!pending) {
      pending = (async () => {
        const response = await fetch(wasmUrl, { signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error(`Capstone download failed: HTTP ${response.status}`);
        return instantiate(await response.arrayBuffer());
      })().catch(error => { pending = null; throw error; });
    }
    return pending;
  }
  const exported = { load, instantiate };
  if (typeof module !== "undefined" && module.exports) module.exports = exported;
  else root.Disassembler = exported;
})(globalThis);

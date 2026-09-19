(function (root) {
  "use strict";
  const memory = typeof module !== "undefined" && module.exports ? require("./memory-view.js") : root.MemoryView;
  const END_ADDRESS = 1n << 64n;

  function request(input) {
    const query = memory.request(input.pid, input.addr, input.size);
    if (query.size > 4082) throw new Error("Page size must be between 1 and 4082 bytes.");
    if (!["arm64", "x86_64"].includes(input.arch)) throw new Error("Select ARM64 or x86-64.");
    const start = memory.address(query.addr);
    if (input.arch === "arm64" && start % 4n) throw new Error("ARM64 addresses must be 4-byte aligned.");
    const end = input.end ? memory.address(input.end) : END_ADDRESS;
    if (end <= start) throw new Error("Empty memory region.");
    const available = Number(end - start < 4096n ? end - start : 4096n);
    const size = Math.min(query.size, available);
    // Look ahead to finish the last instruction without cutting a variable-length opcode.
    const readSize = Math.min(size + (input.arch === "arm64" ? 3 : 14), available);
    return { ...query, size, arch: input.arch, end: input.end || null, readSize };
  }

  function nextPage(query, consumed) {
    const next = memory.address(query.addr) + BigInt(consumed);
    const end = query.end ? memory.address(query.end) : END_ADDRESS;
    if (next >= end) return null;
    return { ...query, addr: memory.hex(next), size: Number(end - next < BigInt(query.size) ? end - next : BigInt(query.size)) };
  }

  function create(doc, api, loadDecoder = () => root.Disassembler.load(), actions = {}) {
    const el = Object.fromEntries(["Form", "Pid", "Addr", "Size", "Arch", "Read", "Prev", "Next", "Refresh", "Status", "Rows", "View"]
      .map(name => [name, doc.querySelector(`#disasm${name}`)]));
    let version = 0, controller = null, loaded = null, next = null, history = [];

    function message(text, error = false) {
      el.Status.textContent = text;
      el.Status.classList.toggle("memory-error", error);
    }
    function controls(busy) {
      el.View.setAttribute("aria-busy", String(busy));
      el.Read.disabled = busy;
      el.Refresh.disabled = busy || !loaded;
      el.Prev.disabled = busy || !history.length;
      el.Next.disabled = busy || !next;
    }
    function clear() {
      version++;
      controller?.abort();
      controller = null;
      loaded = null;
      next = null;
      el.Rows.replaceChildren();
    }
    function reset() {
      clear();
      history = [];
      controls(false);
      message("No instructions loaded.");
    }
    function render(result, query) {
      const fragment = doc.createDocumentFragment();
      for (const row of result.rows) {
        const tr = doc.createElement("tr");
        if (row.invalid) tr.className = "disasm-invalid";
        for (const value of [memory.hex(row.addr), row.bytes.map(b => b.toString(16).padStart(2, "0")).join(" "), row.mnemonic, row.operands]) {
          const td = doc.createElement("td");
          td.textContent = value;
          tr.append(td);
        }
        const td = doc.createElement("td");
        const button = doc.createElement("button");
        button.type = "button";
        button.className = "secondary compact";
        button.textContent = "Breakpoint";
        button.title = `Prepare execution breakpoint at ${memory.hex(row.addr)}`;
        button.disabled = row.invalid || !actions.breakpoint;
        button.addEventListener("click", () => actions.breakpoint?.(query.pid, memory.hex(row.addr)));
        td.append(button);
        tr.append(td);
        fragment.append(tr);
      }
      el.Rows.replaceChildren(fragment);
    }
    async function read(input, navigation = "jump") {
      const previous = loaded;
      clear();
      if (navigation === "jump") history = [];
      const current = version;
      let timer;
      try {
        const query = request(input);
        el.Pid.value = String(query.pid);
        el.Addr.value = query.addr;
        el.Size.value = String(query.size);
        el.Arch.value = query.arch;
        controller = new AbortController();
        const active = controller;
        timer = setTimeout(() => active.abort(), 15000);
        controls(true);
        message(`Reading PID ${query.pid} at ${query.addr}...`);
        const wireQuery = { pid: query.pid, addr: query.addr, size: query.readSize };
        const body = await api(`/memory/read?${new URLSearchParams(wireQuery)}`, { signal: active.signal, cache: "no-store" });
        if (current !== version) return;
        memory.validateResponse(body, wireQuery);
        message("Decoding instructions...");
        const decode = await loadDecoder();
        if (current !== version) return;
        if (active.signal.aborted) throw new DOMException("Timed out", "AbortError");
        const result = decode(body.data, memory.address(query.addr), query.arch, query.size);
        render(result, query);
        loaded = query;
        next = nextPage(query, result.consumed);
        if (navigation === "next" && previous) history.push(previous);
        if (navigation === "previous") history.pop();
        const invalid = result.rows.filter(row => row.invalid).length;
        message(`PID ${query.pid} | ${query.arch === "arm64" ? "ARM64" : "x86-64"} | ${query.addr} | ${result.rows.length - invalid} instructions | ${result.consumed} bytes${invalid ? ` | ${invalid} invalid/incomplete` : ""}`);
      } catch (error) {
        if (current === version) message(error.name === "AbortError" ? "Disassembly request timed out. Retry Read / Jump." : error.message, true);
      } finally {
        clearTimeout(timer);
        if (current === version) { controller = null; controls(false); }
      }
    }
    el.Form.addEventListener("submit", event => {
      event.preventDefault();
      return read({ pid: el.Pid.value, addr: el.Addr.value, size: el.Size.value, arch: el.Arch.value });
    });
    for (const input of [el.Pid, el.Addr, el.Size]) input.addEventListener("input", reset);
    el.Arch.addEventListener("change", reset);
    el.Refresh.addEventListener("click", () => loaded && read(loaded, "refresh"));
    el.Next.addEventListener("click", () => next && read(next, "next"));
    el.Prev.addEventListener("click", () => history.length && read(history[history.length - 1], "previous"));
    reset();
    return {
      reset,
      setPid(pid) { reset(); el.Pid.value = String(pid); },
      usePidIfEmpty(pid) { if (!el.Pid.value && pid) el.Pid.value = String(pid); },
      open(pid, addr, end = null, arch = el.Arch.value) {
        try {
          const start = memory.address(addr);
          const available = (end ? memory.address(end) : END_ADDRESS) - start;
          const size = Number(available < 256n ? available : 256n);
          return read({ pid, addr, size, arch, end });
        } catch (error) { reset(); message(error.message, true); }
      },
    };
  }
  const exported = { request, nextPage, create };
  if (typeof module !== "undefined" && module.exports) module.exports = exported;
  else root.DisassemblyView = exported;
})(globalThis);

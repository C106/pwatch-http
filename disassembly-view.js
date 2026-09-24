(function (root) {
  "use strict";
  const memory = typeof module !== "undefined" && module.exports ? require("./memory-view.js") : root.MemoryView;
  const END_ADDRESS = 1n << 64n;

  function operandTarget(row, arch) {
    if (row.invalid) return null;
    const mnemonic = row.mnemonic.toLowerCase();
    const text = row.operands;
    const direct = arch === "arm64"
      ? /^(b|bl|b\.[a-z]+|cbz|cbnz|tbz|tbnz|adr|adrp|ldr|ldrsw|prfm)$/.test(mnemonic)
      : /^(j[a-z]+|call|loop|loope|loopne)$/.test(mnemonic);
    // Capstone has already resolved PC-relative immediates to absolute addresses.
    if (direct) {
      const match = /(?:^|,\s*)(#?(?:0x[0-9a-f]+|[0-9]+))$/i.exec(text);
      if (match) {
        const value = BigInt(match[1].replace(/^#/, ""));
        if (value < END_ADDRESS) return { start: text.length - match[1].length, end: text.length, addr: memory.hex(value), indirect: false };
      }
    }
    if (arch !== "x86_64" || /\b(?:fs|gs):/i.test(text)) return null;
    // Only address expressions independent of live register values are navigable.
    const match = /\[(?:(rip|eip)(?:\s*([+-])\s*(0x[0-9a-f]+|[0-9]+))?|(0x[0-9a-f]+|[0-9]+))\]/i.exec(text);
    if (!match) return null;
    let value;
    if (match[1]) {
      const displacement = BigInt(match[3] || "0") * (match[2] === "-" ? -1n : 1n);
      value = BigInt.asUintN(match[1].toLowerCase() === "eip" ? 32 : 64, row.addr + BigInt(row.bytes.length) + displacement);
    } else {
      value = BigInt(match[4]);
    }
    if (value >= END_ADDRESS) return null;
    return { start: match.index, end: match.index + match[0].length, addr: memory.hex(value), indirect: true };
  }

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

  function create(doc, api, loadDecoder = () => root.Disassembler.load(), actions = {}, resolveAddress = (_pid, expression) => expression) {
    const el = Object.fromEntries(["Form", "Pid", "Addr", "Size", "Arch", "Read", "Prev", "Next", "Back", "Forward", "History", "Refresh", "Status", "Rows", "View"]
      .map(name => [name, doc.querySelector(`#disasm${name}`)]));
    let version = 0, controller = null, loaded = null, next = null, history = [];
    let visits = [], visitIndex = -1;

    function rememberScroll() {
      if (loaded && visits[visitIndex]) visits[visitIndex].scroll = el.View.scrollTop || 0;
    }
    function renderHistory() {
      el.History.replaceChildren();
      const entries = visits.length ? visits : [null];
      entries.forEach((entry, index) => {
        const option = doc.createElement("option");
        option.value = String(index);
        option.textContent = entry ? `${index + 1}. PID ${entry.query.pid} | ${entry.query.arch} | ${entry.query.addr}` : "No jump history";
        el.History.append(option);
      });
      el.History.value = String(Math.max(0, visitIndex));
    }

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
      el.Back.disabled = busy || (loaded ? visitIndex < 1 : visitIndex < 0);
      el.Forward.disabled = busy || visitIndex + 1 >= visits.length;
      el.History.disabled = busy || !visits.length;
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
      visits = [];
      visitIndex = -1;
      renderHistory();
      controls(false);
      message("No instructions loaded.");
    }
    function editAddress() {
      rememberScroll();
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
        for (const value of [memory.hex(row.addr), row.bytes.map(b => b.toString(16).padStart(2, "0")).join(" "), row.mnemonic]) {
          const td = doc.createElement("td");
          td.textContent = value;
          tr.append(td);
        }
        const operands = doc.createElement("td");
        const target = operandTarget(row, query.arch);
        if (target) {
          const before = doc.createElement("span");
          before.textContent = row.operands.slice(0, target.start);
          const link = doc.createElement("button");
          link.type = "button";
          link.className = "operand-address";
          link.textContent = row.operands.slice(target.start, target.end);
          link.title = `${target.indirect ? "Open memory address" : "Jump to"} ${target.addr}`;
          link.addEventListener("click", () => {
            if (loaded !== query || controller) return;
            const remaining = END_ADDRESS - memory.address(target.addr);
            return read({ ...query, addr: target.addr, end: null, size: Number(remaining < BigInt(query.size) ? remaining : BigInt(query.size)) });
          });
          const after = doc.createElement("span");
          after.textContent = row.operands.slice(target.end);
          operands.append(before, link, after);
        } else operands.textContent = row.operands;
        tr.append(operands);
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
    async function read(input, navigation = "jump", destination = -1) {
      const previous = loaded;
      rememberScroll();
      const scroll = el.View.scrollTop || 0;
      const restoring = navigation === "visit" ? visits[destination] : null;
      clear();
      const current = version;
      let timer;
      try {
        request({ ...input, addr: "0", end: null });
        controller = new AbortController();
        const active = controller;
        timer = setTimeout(() => active.abort(), 15000);
        controls(true);
        message("Resolving address...");
        let resolved = resolveAddress(input.pid, input.addr, { signal: active.signal });
        if (resolved?.then) resolved = await resolved;
        if (current !== version) return;
        active.signal.throwIfAborted();
        const query = request({ ...input, addr: resolved });
        const expression = String(input.addr).trim();
        const prefix = expression !== query.addr ? `Resolved ${expression} to ${query.addr}. ` : "";
        el.Pid.value = String(query.pid);
        el.Addr.value = query.addr;
        el.Size.value = String(query.size);
        el.Arch.value = query.arch;
        message(`${prefix}Reading PID ${query.pid} at ${query.addr}...`);
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
        if (navigation === "jump") history = [];
        if (restoring) history = [...restoring.pages];
        if (navigation === "next" && previous) history.push(previous);
        if (navigation === "previous") history.pop();
        if (restoring) {
          visitIndex = destination;
        } else if (navigation === "jump") {
          visits = visits.slice(0, visitIndex + 1);
          const last = visits[visits.length - 1]?.query;
          if (!last || ["pid", "addr", "arch", "size", "end"].some(key => last[key] !== query[key])) {
            visits.push({ query, pages: [], scroll: 0 });
          }
          if (visits.length > 100) visits.shift();
          visitIndex = visits.length - 1;
        } else if (navigation !== "refresh") visits = visits.slice(0, visitIndex + 1);
        el.View.scrollTop = restoring ? restoring.scroll : navigation === "refresh" ? scroll : 0;
        visits[visitIndex] = { query, pages: [...history], scroll: el.View.scrollTop };
        const invalid = result.rows.filter(row => row.invalid).length;
        message(`${prefix}PID ${query.pid} | ${query.arch === "arm64" ? "ARM64" : "x86-64"} | ${query.addr} | ${result.rows.length - invalid} instructions | ${result.consumed} bytes${invalid ? ` | ${invalid} invalid/incomplete` : ""}`);
      } catch (error) {
        if (current === version) message(error.name === "AbortError" ? "Disassembly request timed out. Retry Read / Jump." : error.message, true);
      } finally {
        clearTimeout(timer);
        if (current === version) { controller = null; renderHistory(); controls(false); }
      }
    }
    el.Form.addEventListener("submit", event => {
      event.preventDefault();
      return read({ pid: el.Pid.value, addr: el.Addr.value, size: el.Size.value, arch: el.Arch.value });
    });
    for (const input of [el.Addr, el.Size]) input.addEventListener("input", editAddress);
    el.Pid.addEventListener("input", reset);
    el.Arch.addEventListener("change", reset);
    el.Refresh.addEventListener("click", () => loaded && read(loaded, "refresh"));
    el.Next.addEventListener("click", () => next && read(next, "next"));
    el.Prev.addEventListener("click", () => history.length && read(history[history.length - 1], "previous"));
    function visit(index) {
      if (!controller && visits[index]) return read(visits[index].query, "visit", index);
    }
    el.Back.addEventListener("click", () => visit(loaded ? visitIndex - 1 : visitIndex));
    el.Forward.addEventListener("click", () => visit(visitIndex + 1));
    el.History.addEventListener("change", () => visit(Number(el.History.value)));
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
        } catch (error) { editAddress(); message(error.message, true); }
      },
    };
  }
  const exported = { operandTarget, request, nextPage, create };
  if (typeof module !== "undefined" && module.exports) module.exports = exported;
  else root.DisassemblyView = exported;
})(globalThis);

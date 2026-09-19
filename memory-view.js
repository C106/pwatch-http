/* Standalone Hex View; all address arithmetic stays in BigInt. */
(function (root) {
  "use strict";
  const MAX_ADDRESS = (1n << 64n) - 1n;

  function address(text) {
    const digits = String(text).trim().replace(/^0x/i, "");
    if (!/^[0-9a-f]{1,16}$/i.test(digits)) throw new Error("Address must be 1–16 hexadecimal digits (optional 0x prefix).");
    return BigInt(`0x${digits}`);
  }

  function hex(value) { return `0x${value.toString(16).padStart(16, "0")}`; }

  function request(pid, addr, size) {
    pid = Number(pid);
    size = Number(size);
    if (!Number.isInteger(pid) || pid < 1 || pid > 2147483647) throw new Error("PID must be between 1 and 2147483647.");
    if (!Number.isInteger(size) || size < 1 || size > 4096) throw new Error("Read size must be between 1 and 4096 bytes.");
    addr = address(addr);
    if (addr + BigInt(size - 1) > MAX_ADDRESS) throw new Error("Read extends beyond the 64-bit address range.");
    return { pid, addr: hex(addr), size };
  }

  function rows(addr, data) {
    const start = address(addr);
    const result = [];
    for (let offset = 0; offset < data.length; offset += 16) {
      const bytes = data.slice(offset, offset + 16);
      result.push({
        addr: hex(start + BigInt(offset)),
        hex: bytes.map(byte => byte.toString(16).padStart(2, "0")).join(" ").padEnd(47, " "),
        ascii: bytes.map(byte => byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : ".").join(""),
      });
    }
    return result;
  }

  function validateResponse(body, query) {
    if (!body || body.pid !== query.pid || typeof body.addr !== "string"
      || address(body.addr) !== address(query.addr) || body.size !== query.size
      || !Array.isArray(body.data) || body.data.length !== query.size
      || !body.data.every(b => Number.isInteger(b) && b >= 0 && b <= 255)) {
      throw new Error("Invalid memory response: expected the requested address and byte count.");
    }
    return rows(body.addr, body.data);
  }

  function page(query, direction) {
    const addr = address(query.addr);
    if (direction < 0) {
      if (addr === 0n) return null;
      return { ...query, addr: hex(addr > BigInt(query.size) ? addr - BigInt(query.size) : 0n) };
    }
    const next = addr + BigInt(query.size);
    if (next > MAX_ADDRESS) return null;
    return { ...query, addr: hex(next), size: Number(BigInt(query.size) < MAX_ADDRESS - next + 1n ? BigInt(query.size) : MAX_ADDRESS - next + 1n) };
  }

  function create(doc, api) {
    const el = Object.fromEntries(["Form", "Pid", "Addr", "Size", "Read", "Prev", "Next", "Refresh", "Status", "Rows", "View"]
      .map(name => [name, doc.querySelector(`#memory${name}`)]));
    let version = 0, controller = null, loaded = null;

    function message(text, error = false) {
      el.Status.textContent = text;
      el.Status.classList.toggle("memory-error", error);
    }
    function controls(busy) {
      el.View.setAttribute("aria-busy", String(busy));
      el.Read.disabled = busy;
      el.Refresh.disabled = busy || !loaded;
      el.Prev.disabled = busy || !loaded || !page(loaded, -1);
      el.Next.disabled = busy || !loaded || !page(loaded, 1);
    }
    function reset() {
      version++;
      controller?.abort();
      controller = null;
      loaded = null;
      el.Rows.replaceChildren();
      controls(false);
      message("Enter a PID and hexadecimal address to read memory.");
    }
    async function read(query) {
      reset();
      const current = version;
      try {
        query = request(query.pid, query.addr, query.size);
        el.Pid.value = String(query.pid);
        el.Addr.value = query.addr;
        el.Size.value = String(query.size);
        const activeController = new AbortController();
        controller = activeController;
        const timer = setTimeout(() => activeController.abort(), 15000);
        controls(true);
        message(`Reading PID ${query.pid} at ${query.addr}…`);
        let body;
        try {
          body = await api(`/memory/read?${new URLSearchParams(query)}`, { signal: activeController.signal, cache: "no-store" });
        } finally { clearTimeout(timer); }
        if (current !== version) return;
        const formatted = validateResponse(body, query);
        const fragment = doc.createDocumentFragment();
        for (const row of formatted) {
          const tr = doc.createElement("tr");
          for (const value of [row.addr, row.hex, row.ascii]) {
            const td = doc.createElement("td");
            td.textContent = value; // Memory bytes must never be interpreted as HTML.
            tr.append(td);
          }
          fragment.append(tr);
        }
        el.Rows.replaceChildren(fragment);
        loaded = query;
        message(`PID ${query.pid} · ${query.addr} – ${hex(address(query.addr) + BigInt(query.size - 1))} · ${query.size} bytes`);
      } catch (error) {
        if (current === version) message(error.name === "AbortError" ? "Memory request timed out. Retry Read / Jump." : error.message, true);
      } finally {
        if (current === version) { controller = null; controls(false); }
      }
    }
    function readInputs(event) {
      event.preventDefault();
      return read({ pid: el.Pid.value, addr: el.Addr.value, size: el.Size.value });
    }
    el.Form.addEventListener("submit", readInputs);
    for (const input of [el.Pid, el.Addr, el.Size]) input.addEventListener("input", reset);
    el.Refresh.addEventListener("click", () => loaded && read(loaded));
    el.Prev.addEventListener("click", () => loaded && read(page(loaded, -1)));
    el.Next.addEventListener("click", () => loaded && read(page(loaded, 1)));
    reset();
    return {
      reset,
      setPid(pid) { reset(); el.Pid.value = String(pid); },
      usePidIfEmpty(pid) { if (!el.Pid.value && pid) el.Pid.value = String(pid); },
      open(pid, addr, end) {
        try {
          let size = 256;
          if (end) {
            const length = address(end) - address(addr);
            if (length < 1n) throw new Error("Empty memory region.");
            size = Number(length < 256n ? length : 256n);
          }
          return read({ pid, addr, size });
        } catch (error) { reset(); message(error.message, true); }
      },
    };
  }
  const exported = { address, hex, request, rows, validateResponse, page, create };
  if (typeof module !== "undefined" && module.exports) module.exports = exported;
  else root.MemoryView = exported;
})(globalThis);

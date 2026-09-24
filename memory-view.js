/* Standalone Hex View; all address arithmetic stays in BigInt. */
(function (root) {
  "use strict";
  const MAX_ADDRESS = (1n << 64n) - 1n;
  const REFRESH_MS = 500;

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

  function create(doc, api, resolveAddress = (_pid, expression) => expression) {
    const el = Object.fromEntries(["Form", "Pid", "Addr", "Size", "Read", "Prev", "Next", "Refresh", "Auto", "Status", "Rows", "View"]
      .map(name => [name, doc.querySelector(`#memory${name}`)]));
    let version = 0, controller = null, loaded = null;
    let snapshot = null, pollTimer = null, flashTimer = null, active = true;

    function cancelPoll() { clearTimeout(pollTimer); pollTimer = null; }
    function schedule() {
      cancelPoll();
      if (el.Auto.checked && active && !doc.hidden && loaded && !controller) {
        pollTimer = setTimeout(() => { pollTimer = null; void read(loaded, "auto"); }, REFRESH_MS);
      }
    }
    function render(formatted, data, previous) {
      clearTimeout(flashTimer);
      const fragment = doc.createDocumentFragment();
      const changed = [];
      let count = 0;
      formatted.forEach((row, rowIndex) => {
        const tr = doc.createElement("tr");
        const addr = doc.createElement("td");
        addr.textContent = row.addr;
        const bytes = doc.createElement("td");
        const ascii = doc.createElement("td");
        const offset = rowIndex * 16;
        const length = Math.min(16, data.length - offset);
        for (let i = 0; i < length; i++) {
          const value = data[offset + i];
          const difference = previous && value !== previous[offset + i];
          if (difference) count++;
          for (const [cell, text] of [[bytes, value.toString(16).padStart(2, "0")], [ascii, value >= 32 && value <= 126 ? String.fromCharCode(value) : "."]]) {
            const span = doc.createElement("span");
            span.textContent = text;
            if (difference) {
              span.className = "memory-changed";
              span.title = `${hex(address(row.addr) + BigInt(i))}: ${previous[offset + i].toString(16).padStart(2, "0")} → ${value.toString(16).padStart(2, "0")}`;
              changed.push(span);
            }
            cell.append(span);
          }
          if (i < length - 1) {
            const space = doc.createElement("span");
            space.textContent = " ";
            bytes.append(space);
          }
        }
        if (length < 16) {
          const padding = doc.createElement("span");
          padding.textContent = " ".repeat((16 - length) * 3);
          bytes.append(padding);
        }
        tr.append(addr, bytes, ascii);
        fragment.append(tr);
      });
      const top = el.View.scrollTop, left = el.View.scrollLeft;
      el.Rows.replaceChildren(fragment);
      el.View.scrollTop = top;
      el.View.scrollLeft = left;
      if (changed.length) flashTimer = setTimeout(() => {
        for (const span of changed) span.classList.remove("memory-changed");
        flashTimer = null;
      }, REFRESH_MS);
      return count;
    }

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
      cancelPoll();
      clearTimeout(flashTimer);
      flashTimer = null;
      version++;
      controller?.abort();
      controller = null;
      loaded = null;
      snapshot = null;
      el.Rows.replaceChildren();
      controls(false);
      message("Enter a PID and address expression to read memory.");
    }
    async function read(input, mode = "jump") {
      const refreshing = mode !== "jump" && loaded;
      if (refreshing) {
        cancelPoll();
        version++;
        controller?.abort();
      } else reset();
      const current = version;
      let timer;
      try {
        request(input.pid, "0", input.size); // Validate PID/size before resolving remotely.
        const activeController = new AbortController();
        controller = activeController;
        timer = setTimeout(() => activeController.abort(), 15000);
        controls(true);
        if (mode !== "auto") message("Resolving address...");
        let resolved = resolveAddress(input.pid, input.addr, { signal: activeController.signal });
        if (resolved?.then) resolved = await resolved;
        if (current !== version) return;
        activeController.signal.throwIfAborted();
        const query = request(input.pid, resolved, input.size);
        const expression = String(input.addr).trim();
        const prefix = expression !== query.addr ? `Resolved ${expression} to ${query.addr}. ` : "";
        el.Pid.value = String(query.pid);
        el.Addr.value = query.addr;
        el.Size.value = String(query.size);
        if (mode !== "auto") message(`${prefix}Reading PID ${query.pid} at ${query.addr}…`);
        const body = await api(`/memory/read?${new URLSearchParams(query)}`, { signal: activeController.signal, cache: "no-store" });
        if (current !== version) return;
        activeController.signal.throwIfAborted();
        const formatted = validateResponse(body, query);
        const previous = loaded && ["pid", "addr", "size"].every(key => loaded[key] === query[key]) ? snapshot : null;
        const changed = render(formatted, body.data, previous);
        snapshot = body.data.slice();
        loaded = query;
        message(`${prefix}PID ${query.pid} · ${query.addr} – ${hex(address(query.addr) + BigInt(query.size - 1))} · ${query.size} bytes${previous ? ` · ${changed} changed` : ""}`);
      } catch (error) {
        if (current === version) {
          loaded = null;
          snapshot = null;
          clearTimeout(flashTimer);
          flashTimer = null;
          el.Rows.replaceChildren();
          const stopped = el.Auto.checked;
          el.Auto.checked = false;
          message((error.name === "AbortError" ? "Memory request timed out. Retry Read / Jump." : error.message)
            + (stopped ? " Auto refresh stopped." : ""), true);
        }
      } finally {
        clearTimeout(timer);
        if (current === version) { controller = null; controls(false); schedule(); }
      }
    }
    function readInputs(event) {
      event.preventDefault();
      return read({ pid: el.Pid.value, addr: el.Addr.value, size: el.Size.value });
    }
    el.Form.addEventListener("submit", readInputs);
    for (const input of [el.Pid, el.Addr, el.Size]) input.addEventListener("input", reset);
    el.Refresh.addEventListener("click", () => !controller && loaded && read(loaded, "refresh"));
    el.Auto.addEventListener("change", schedule);
    doc.addEventListener?.("visibilitychange", schedule);
    el.Prev.addEventListener("click", () => loaded && read(page(loaded, -1)));
    el.Next.addEventListener("click", () => loaded && read(page(loaded, 1)));
    reset();
    return {
      reset,
      setActive(value) { active = value; schedule(); },
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

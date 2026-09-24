/* Resolve numeric and module-relative address expressions without losing u64 precision. */
(function (root) {
  "use strict";
  const MAX = (1n << 64n) - 1n;
  const NUMBER = /^(?:0x)?[0-9a-f]+$/i;
  const SUFFIX =
    /^(.+?)(\s*[+-]\s*(?:0x)?[0-9a-f]+(?:\s*[+-]\s*(?:0x)?[0-9a-f]+)*)$/i;

  function numeric(value) {
    const text = String(value).trim();
    if (!NUMBER.test(text))
      throw new Error(`Invalid hexadecimal address: ${value}`);
    const digits = text.replace(/^0x/i, "");
    const result = BigInt(`0x${digits}`);
    if (digits.length > 16 || result > MAX)
      throw new Error("Address exceeds the 64-bit range.");
    return result;
  }

  function parse(expression) {
    const text = String(expression).trim();
    if (!text) throw new Error("Address expression is empty.");
    if (text.length > 4096) throw new Error("Address expression is too long.");
    let base = text,
      tail = "",
      quoted = false;
    if (text[0] === '"' || text[0] === "'") {
      const end = text.indexOf(text[0], 1);
      if (end < 0) throw new Error("Unterminated module name.");
      base = text.slice(1, end);
      tail = text.slice(end + 1);
      quoted = true;
    } else {
      const match = text.match(SUFFIX);
      if (match) {
        base = match[1].trim();
        tail = match[2];
      }
    }
    const terms = [];
    while (tail.trim()) {
      const term = tail.match(
        /^\s*([+-])\s*((?:0x)?[0-9a-f]+)(?=\s*[+-]|\s*$)/i,
      );
      if (!term)
        throw new Error(
          "Offsets must be hexadecimal numbers joined by + or -.",
        );
      terms.push({ sign: term[1] === "-" ? -1 : 1, value: numeric(term[2]) });
      tail = tail.slice(term[0].length);
    }
    if (!quoted && NUMBER.test(base))
      return { kind: "numeric", value: numeric(base), terms };
    if (
      !base ||
      /[+"'\x00-\x1f]/.test(base) ||
      (!quoted && (/^[+-]|^0x/i.test(base) || /\s|[()*]/.test(base)))
    )
      throw new Error(
        "Invalid address expression. Quote module paths containing spaces or operators.",
      );
    return { kind: "module", module: base, terms };
  }

  function hex(value) {
    if (value < 0n || value > MAX)
      throw new Error("Resolved address exceeds the 64-bit range.");
    return `0x${value.toString(16).padStart(16, "0")}`;
  }

  function evaluate(parsed, base) {
    let value = base;
    for (const term of parsed.terms) {
      value += term.sign > 0 ? term.value : -term.value;
      if (value < 0n || value > MAX)
        throw new Error("Resolved address exceeds the 64-bit range.");
    }
    return hex(value);
  }

  function resolve(pid, expression, api, options = {}) {
    pid = Number(pid);
    if (!Number.isInteger(pid) || pid < 1 || pid > 2147483647)
      throw new Error("PID must be between 1 and 2147483647.");
    const parsed = parse(expression);
    if (parsed.kind === "numeric") return evaluate(parsed, parsed.value);
    // The existing backend accepts module + offset; ask only for the base.
    const params = new URLSearchParams({ addr: `${parsed.module} + 0x0` });
    return api(`/processes/${pid}/resolve?${params}`, {
      ...options,
      cache: "no-store",
    }).then((body) => {
      options.signal?.throwIfAborted();
      if (
        !body ||
        typeof body.address !== "string" ||
        !NUMBER.test(body.address)
      )
        throw new Error(
          "Invalid module resolution response: expected a hexadecimal address string.",
        );
      return evaluate(parsed, numeric(body.address));
    });
  }

  const exported = { numeric, parse, hex, evaluate, resolve };
  if (typeof module !== "undefined" && module.exports)
    module.exports = exported;
  else root.AddressExpressions = exported;
})(globalThis);

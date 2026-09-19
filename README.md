# pwatch-ui

Standalone browser dashboard for `pwatch serve`.

## Run

Start the API:

```bash
cargo run -- serve --listen 0.0.0.0:8080
```

Serve this directory from any static file server:

```bash
python3 -m http.server 5173
```

Open:

```text
http://127.0.0.1:5173
```

Set the API endpoint in the sidebar, for example:

```text
http://127.0.0.1:8080
```

The UI is intentionally independent from the Rust binary. It can be hosted on
another machine as long as it can reach the `pwatch serve` address.

## Memory Hex View

Open the **Memory** tab, enter a PID, a hexadecimal address (with or without
`0x`), and a read size from 1 to 4096 bytes. Click **Read / Jump**. The default
page is 256 bytes, displayed as 16 hexadecimal bytes plus ASCII per row.
Non-printable bytes appear as `.`. The final partial row is not zero-filled.

**Previous**, **Next**, and **Refresh** operate on the last successful read.
Addresses use `BigInt` throughout, including addresses larger than JavaScript's
safe integer range. Editing inputs clears the old view. Errors are displayed
inline; no bytes are fabricated for failed or incomplete reads.

Selecting a process also sets the memory PID. In **Maps**, click **Hex** to read
from that region's start (up to 256 bytes, bounded by the region end for the
initial read). Later pages may cross a mapping boundary and return a driver error.

Requires the main-branch LK1337 HTTP backend:

```text
GET /memory/read?pid=1234&addr=0x7000000000&size=256
```

Expected JSON: `{ "pid":1234, "addr":"0x0000007000000000", "size":2,
"data":[65,66], "rows":[...], "next_addr":"0x0000007000000002" }`
(Example payload is shortened to two bytes; `size` must match the request.)
The UI formats `data` into hex rows and uses text nodes for ASCII output.
This view is read-only and does not call `/memory/write`.
Requests time out after 15 seconds, and stale responses are ignored when the
process, address, or connected API changes. Click **Connect** to apply an API
endpoint change. An HTTPS-hosted page may be unable to reach a plain HTTP API
due to browser mixed-content rules; use a local HTTP page or an HTTPS API proxy.

Run the dependency-free frontend tests with Node.js:

```bash
node --test tests/memory-view.test.cjs
node --check memory-view.js
node --check app.js
```

## Disassembly

Open **Disassembly**, enter a PID and hexadecimal instruction address, select
**ARM64 (little-endian)** or **x86-64 (Intel syntax)**, then click **Read / Jump**.
ARM64 addresses must be 4-byte aligned. Choose the architecture explicitly for
manual reads and Maps; the memory API does not report the target architecture.

The table shows each instruction's address, original bytes, mnemonic and
operands. Invalid or incomplete instructions remain visible as `.byte` rows.
**Breakpoint** fills the sidebar with an execution breakpoint at that address;
it does not create a breakpoint until you click **Create**.

- **Maps → Disassemble** starts at the selected mapping and bounds all pages to
  its end. A manual Read / Jump starts a new, unbounded navigation session.
- **Hits → Disassemble** opens the hit's PC/IP and selects the architecture from
  the register name. These are current memory bytes, not a snapshot from hit time.
- The right arrow continues at the next instruction boundary. The left arrow
  returns to the previous visited page (not a guessed x86 instruction boundary).
  The circular arrow rereads the current page. Buttons have keyboard-accessible
  labels and tooltips.

Page size is 1–4082 bytes (default 256). The reader may fetch up to 14 additional
bytes to finish the last x86 instruction, or 3 for ARM64, within the API's
4096-byte limit and mapping/u64 bounds. Displayed page length can therefore
exceed the selected size. Unbounded reads near mapping boundaries can fail;
use the Maps action or a smaller page in that case.

The pinned Capstone WASM binary is served from `vendor/capstone/`; no CDN,
backend disassembly endpoint, npm install or build step is required. Serve the
whole directory over HTTP, including the WASM and SVG assets. The binary's
provenance, SHA-256 and license notices are in that directory. Navigation icons
are Lucide `lucide-static@0.468.0` (ISC; see `vendor/lucide/LICENSE`).
Use a modern browser with WebAssembly BigInt support. Address arithmetic and
branch-target decoding preserve all 64 bits. Read/engine loading failures are
shown inline; changing inputs, selecting a process or reconnecting clears stale
results. Memory access remains read-only.

Run all tests, including real Capstone ARM64/x86-64 instruction fixtures:

```bash
node --test tests/*.test.cjs
node --check disassembler.js
node --check disassembly-view.js
node --check app.js
```

With the static server running, open `/tests/browser-smoke.html` for the
browser integration check. It uses a mock memory API and the real local WASM
engine, exercising Maps/Hits navigation, paging, breakpoint preparation and
viewport overflow. A successful run displays `PASS`.

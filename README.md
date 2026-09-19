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

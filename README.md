# pwatch

A cli tool to install a hardware breakpoint/watchpoint on a process in linux. This is useful for debugging a process without having to attach a debugger to it.

Now it supports x86_64 and arm64. You can use it on rooted Android devices as well.

## Usage

```
pwatch <pid> <type> <addr>
pwatch -t <tid> <type> <addr>
```
For example:
```bash
pwatch 31737 rw4 0x55fa689a90
```
This will install a read/write 4 byte watchpoint on the address `0x55fa689a90` of all threads in the process with pid `31737`.

full arguments:
```
Usage: pwatch [OPTIONS] <PID> <TYPE> <ADDR>

Arguments:
  <PID>   target pid, if thread is true, this is the tid of the target thread
  <TYPE>  watchpoint type, can be read(r), write(w), readwrite(rw) or execve(x). if it is one of r, w, rw, the watchpoint length is needed. Valid length is 1, 2, 4, 8. For example, r4 means a read watchpoint with length 4 and rw1 means a readwrite watchpoint with length 1
  <ADDR>  watchpoint address, in hex format. 0x prefix is optional

Options:
      --buf-size <BUF_SIZE>  buffer size, in power of 2. For example, 2 means 2^2 pages = 4 * 4096 bytes [default: 0]
      --timeout <TIMEOUT>    exit after this many seconds. 0 means no timeout [default: 0]
      --filter <FILTER>      register filter for hits, pcap-like. For example: 'ip == 0x1234 and ax != 0'
  -t                         whether the target is a thread or a process
  -b, --backtrace            whether to print backtrace
  -h, --help                 Print help
```

## Filter

`--filter` drops hits before printing them. It supports register comparisons joined with `and`/`or` or `&&`/`||`.

Examples:

```bash
pwatch --filter 'ip == 0x55fa689a90' 31737 x 0x55fa689a90
pwatch --filter 'ax != 0 and flags & 0x40 == 0' 31737 rw4 0x55fa689a90
pwatch --filter 'pc >= 0x7000000000 && pc < 0x7100000000' 31737 rw4 0x55fa689a90
```

Use the register names printed by pwatch, such as `ax`/`ip` on x86_64 or `x0`/`pc` on aarch64.

## Memory HTTP API

Start the API with `pwatch serve --listen 127.0.0.1:8080`.
Memory operations require the LK1337 driver (ioctl 601/602); there is no
user-space memory access fallback. They do not enable maps filtering or create
breakpoints. Driver calls run on blocking workers.

Read bytes for a Hex View:

```bash
curl 'http://127.0.0.1:8080/memory/read?pid=1234&addr=0x7000000000&size=16'
```

The response includes `pid`, `addr`, `size`, `next_addr`, `data` (byte array),
and `rows` (16 bytes per row, with `addr`, space-separated `hex`, and `ascii`).
The last row is not padded. Non-printable ASCII bytes display as `.`.
Addresses are hexadecimal strings to preserve 64-bit precision in JavaScript;
use `BigInt` for address arithmetic. `next_addr` is null at the u64 boundary.
Use text rendering, not HTML interpolation, for ASCII content.

Write bytes:

```bash
curl -X POST 'http://127.0.0.1:8080/memory/write' \
  -H 'Content-Type: application/json' \
  -d '{"pid":1234,"addr":"0x7000000000","data":"00 11 ab ff"}'
```

Returns `{"pid":1234,"addr":"0x0000007000000000","written":4}` on success.
`data` contains hex byte pairs (no `0x` prefix), with optional ASCII whitespace.
Read back explicitly to refresh the view after writes. Writes are not
transactional: a driver error does not guarantee memory was unchanged.

Both endpoints require a positive signed-32-bit PID and a hexadecimal address
(optional `0x` prefix). Reads default to 256 bytes; reads/writes accept 1..4096
bytes per request. Write request bodies are limited to 16 KiB.
Validation errors return HTTP 400; JSON extraction errors use 400/415/422/413
as appropriate. Driver failures return 502, worker failures 500, with
`{"error":"..."}`. Successful responses use `Cache-Control: no-store`.

### Diagnosing LK1337 bootstrap errors

`bootstrap ... ENOTTY (os error 25)` occurs before memory ioctl 601/602.
It is not a target PID/address error. The bootstrap call uses the socket,
command `0x4b530001`, magic `0x42464946`, and 8-byte request from `LK1337.hpp`.
The returned request FD determines success, even when ioctl returns an error.

Build a bootstrap-only probe (does not read/write memory or enable filtering):

```bash
cargo build --release --target aarch64-unknown-linux-musl --example lk1337_probe
```

Run `target/aarch64-unknown-linux-musl/release/examples/lk1337_probe` on the
device in the same execution context as pwatch. It tests the main thread and
a worker thread independently and prints ioctl return/FD/ABI information on
failure. Compare with the C++ bootstrap on the same device. If no FD is returned,
the installed driver's bootstrap implementation is needed to identify why it
did not handle the request; changing target addresses cannot fix this stage.

## Output

![output](img/output.png)

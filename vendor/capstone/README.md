# Capstone WebAssembly

`capstone.wasm` is the unmodified engine binary from `capstone-wasm@1.0.3`:
https://registry.npmjs.org/capstone-wasm/-/capstone-wasm-1.0.3.tgz

Build repository: https://github.com/CzBiX/disasm-web
Build revision: `7205f6669e2a86868d26acda939721a7637f22d1`
Capstone source revision: `d5141c04785678535c7792eddc21f146186e639f`
Binary SHA-256: `6b3128c714c6e617457ad3d56105c4eaf0429bb5109bba39983537ad1b420771`
The upstream `packages/capstone/build-lib.sh` documents the Emscripten build.

The JavaScript wrapper from that package is not included. `disassembler.js`
binds only the required C API exports and preserves unsigned 64-bit addresses.
Export names and `cs_insn` field offsets are specific to this pinned build;
update the adapter and run the real-engine tests when replacing the binary.

Capstone is distributed under the BSD license in `LICENSE.TXT`, with the
additional LLVM notices in `LICENSE_LLVM.TXT`.

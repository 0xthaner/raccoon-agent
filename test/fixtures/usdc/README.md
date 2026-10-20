# USDC fixtures (Nexus P4F)

Read-only evidence for the independent USDC pin in `src/purchase-pre-send.mjs`.

- `runtime-usdc-*.hex`: deployed runtime code. It was read with `eth_getCode` from two
  providers at one block, and both returned the same bytes.
- `usdc-builds.json`: our own recompilation of both contracts. The provenance is recorded
  in `$comment`.
- `FiatTokenV2_2.sol`, `FiatTokenV1.sol`, `Pausable.sol`: unmodified copies from
  github.com/circlefin/stablecoin-evm, tag v2.2.0 (commit 405efc10). Each file keeps its
  original license header (Apache-2.0, or MIT for `Pausable.sol`), and the copyright
  stays with the respective authors. The files are kept only so `approve` can be checked
  in tests.

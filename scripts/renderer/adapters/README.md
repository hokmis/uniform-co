# Renderer adapters

`uniform-erp-sales-v0.mjs` is a deterministic demonstration adapter for the internal `UNIFORM-ERP-SALES-v0` CSV contract. It is useful for renderer smoke tests and accepts the versioned `uniform-erp-render-payload-v1` DTO emitted by the protected payload RPC.

It is **not** a Dingxin production mapping. The production format remains blocked until a real Dingxin sample is supplied, mapped, and verified against a golden-file/import smoke test. Configure the runner with `RENDER_COMMAND=node` and `RENDER_COMMAND_ARGS=["scripts/renderer/adapters/uniform-erp-sales-v0.mjs"]` when running this demo adapter.

# LifeSpace client crypto foundation

Development-only primitive layer for issue #663; not a complete SDK or published wire contract. It has no dependencies, network, storage, KDF, key-cache policy, file codec or application integration. Account and future client consumers must use the eventual shared implementation instead of copying the primitives into their own code.

Uses standard Web Crypto AES-256-GCM, fresh random 96-bit IV and 128-bit tag. The caller must supply stable, domain-separated nonempty AAD, enforce protocol limits, and clear temporary raw key arrays; runtime memory erasure cannot be guaranteed. Raw DEK bytes never leave trusted client code. Never use this primitive layer directly as a replacement for the reviewed field/key/file contract.

Run `node --test sdk/crypto/primitives.test.mjs` from repository root (the project requires Node >=24). The fixed interoperability vector was independently generated using Python cryptography AESGCM; it uses synthetic test-only values. Password KDF and protocol-level validation are still pending. This directory is intentionally not a published package yet.

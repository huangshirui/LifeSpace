/**
 * Runtime-visible Core Kernel contract version.
 * `scripts/check-openapi.mjs` requires this value, OpenAPI `info.version`,
 * and `StatusResponse.data.contractVersion` to remain identical.
 */
export const CORE_KERNEL_CONTRACT_VERSION = "0.45.0" as const;

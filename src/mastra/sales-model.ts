export const DYNAMITE_FINE_TUNE = 'accounts/abloomster/models/dynamite-sales-qwen27b-v3c'
export const EXISTING_SALES_MODEL = 'accounts/fireworks/models/qwen3p8-2p4t-a95b'

// The v3c training job is READY, but no serving deployment existed at the Oct 22 readback.
// An explicit endpoint must never silently fall back to the base model on failure.
export function resolveSalesModel(modelId = process.env.FIREWORKS_SALES_MODEL): `fireworks-ai/${string}` {
  const selected = modelId?.trim() || EXISTING_SALES_MODEL
  return selected.startsWith('fireworks-ai/')
    ? selected as `fireworks-ai/${string}`
    : `fireworks-ai/${selected}`
}

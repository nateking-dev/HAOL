/**
 * The default meta model — the Anthropic model used for the system's
 * meta-level reasoning tasks: the Layer 2 escalation classifier (when vector
 * routing is low-confidence) and the routing-quality evaluator in
 * outcome-collector.
 *
 * This is the single source of truth for the *default*. The effective runtime
 * value is configurable via `router_config.escalation_model`
 * (see CONFIG_DEFAULTS / loadConfig in reference-store.ts), which falls back to
 * this constant when the row is absent. The seed in src/db/seed.ts writes this
 * same value, so they stay in sync from one definition.
 */
export const META_MODEL_ID = "claude-haiku-4-5-20251001";

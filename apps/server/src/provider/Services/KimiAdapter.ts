/**
 * KimiAdapter - Kimi Code implementation of the generic provider adapter contract.
 *
 * This service owns Kimi runtime/session semantics and emits canonical
 * provider runtime events. It does not perform cross-provider routing, shared
 * event fan-out, or checkpoint orchestration.
 *
 * @module KimiAdapter
 */
import { Context } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * KimiAdapterShape - Service API for the Kimi Code provider adapter.
 */
export interface KimiAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "kimi";
}

/**
 * KimiAdapter - Service tag for Kimi Code provider adapter operations.
 */
export class KimiAdapter extends Context.Service<KimiAdapter, KimiAdapterShape>()(
  "t3/provider/Services/KimiAdapter",
) {}

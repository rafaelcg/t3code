/**
 * KimiProvider - Service tag for the Kimi Code provider snapshot service.
 *
 * @module KimiProvider
 */
import { Context } from "effect";

import type { ServerProviderShape } from "./ServerProvider.ts";

/**
 * KimiProviderShape - Service API for the Kimi Code provider snapshot service.
 */
export interface KimiProviderShape extends ServerProviderShape {}

/**
 * KimiProvider - Service tag for Kimi Code provider snapshot operations.
 */
export class KimiProvider extends Context.Service<KimiProvider, KimiProviderShape>()(
  "t3/provider/Services/KimiProvider",
) {}

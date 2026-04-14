/**
 * RoutingTextGeneration – Dispatches text generation requests to either the
 * Codex CLI or Claude CLI implementation based on the provider in each
 * request input.
 *
 * When `modelSelection.provider` is `"claudeAgent"` the request is forwarded to
 * the Claude layer; for any other value (including the default `undefined`) it
 * falls through to the Codex layer.
 *
 * @module RoutingTextGeneration
 */
import { DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER } from "@t3tools/contracts";
import type { ModelSelection } from "@t3tools/contracts";
import { Effect, Layer, Context } from "effect";

import {
  TextGeneration,
  type TextGenerationProvider,
  type TextGenerationShape,
} from "../Services/TextGeneration.ts";
import { CodexTextGenerationLive } from "./CodexTextGeneration.ts";
import { ClaudeTextGenerationLive } from "./ClaudeTextGeneration.ts";

// ---------------------------------------------------------------------------
// Internal service tags so both concrete layers can coexist.
// ---------------------------------------------------------------------------

class CodexTextGen extends Context.Service<CodexTextGen, TextGenerationShape>()(
  "t3/git/Layers/RoutingTextGeneration/CodexTextGen",
) {}

class ClaudeTextGen extends Context.Service<ClaudeTextGen, TextGenerationShape>()(
  "t3/git/Layers/RoutingTextGeneration/ClaudeTextGen",
) {}

// ---------------------------------------------------------------------------
// Routing implementation
// ---------------------------------------------------------------------------

const makeRoutingTextGeneration = Effect.gen(function* () {
  const codex = yield* CodexTextGen;
  const claude = yield* ClaudeTextGen;

  const route = (provider?: TextGenerationProvider): TextGenerationShape =>
    provider === "claudeAgent" ? claude : codex;

  // Kimi does not have a text-generation CLI implementation yet;
  // fall back to Codex and normalize the model selection so the
  // underlying layer accepts it.
  const normalizeModelSelection = (modelSelection: ModelSelection): ModelSelection => {
    if (modelSelection.provider === "kimi") {
      return {
        provider: "codex",
        model: modelSelection.model ?? DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER.codex,
      } as ModelSelection;
    }
    return modelSelection;
  };

  return {
    generateCommitMessage: (input) => {
      const modelSelection = normalizeModelSelection(input.modelSelection);
      return route(modelSelection.provider).generateCommitMessage({ ...input, modelSelection });
    },
    generatePrContent: (input) => {
      const modelSelection = normalizeModelSelection(input.modelSelection);
      return route(modelSelection.provider).generatePrContent({ ...input, modelSelection });
    },
    generateBranchName: (input) => {
      const modelSelection = normalizeModelSelection(input.modelSelection);
      return route(modelSelection.provider).generateBranchName({ ...input, modelSelection });
    },
    generateThreadTitle: (input) => {
      const modelSelection = normalizeModelSelection(input.modelSelection);
      return route(modelSelection.provider).generateThreadTitle({ ...input, modelSelection });
    },
  } satisfies TextGenerationShape;
});

const InternalCodexLayer = Layer.effect(
  CodexTextGen,
  Effect.gen(function* () {
    const svc = yield* TextGeneration;
    return svc;
  }),
).pipe(Layer.provide(CodexTextGenerationLive));

const InternalClaudeLayer = Layer.effect(
  ClaudeTextGen,
  Effect.gen(function* () {
    const svc = yield* TextGeneration;
    return svc;
  }),
).pipe(Layer.provide(ClaudeTextGenerationLive));

export const RoutingTextGenerationLive = Layer.effect(
  TextGeneration,
  makeRoutingTextGeneration,
).pipe(Layer.provide(InternalCodexLayer), Layer.provide(InternalClaudeLayer));

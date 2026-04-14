import type {
  ModelCapabilities,
  ServerProvider,
  ServerProviderAuth,
  ServerProviderModel,
  ServerProviderState,
} from "@t3tools/contracts";
import { Effect, Equal, Layer, Option, Result, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  detailFromResult,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
} from "../providerSnapshot";
import { makeManagedServerProvider } from "../makeManagedServerProvider";
import { KimiProvider } from "../Services/KimiProvider";
import { ServerSettingsService } from "../../serverSettings";
import { KimiSettings, ServerSettingsError } from "@t3tools/contracts";
import { isLoggedIn, parseConfig } from "@moonshot-ai/kimi-agent-sdk";

const DEFAULT_KIMI_MODEL_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: true,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

const PROVIDER = "kimi" as const;

function mapKimiCapabilities(kimiCaps: ReadonlyArray<string>): ModelCapabilities {
  return {
    reasoningEffortLevels: [],
    supportsFastMode: false,
    supportsThinkingToggle: kimiCaps.includes("thinking") || kimiCaps.includes("always_thinking"),
    contextWindowOptions: [],
    promptInjectedEffortLevels: [],
  };
}

const KIMI_MODEL_DISPLAY_NAMES: Record<string, string> = {
  "kimi-code/kimi-for-coding": "Kimi for Coding",
  "kimi-k2.5": "Kimi K2.5",
  "kimi-latest": "Kimi Latest",
};

function discoverKimiModels(): ReadonlyArray<ServerProviderModel> {
  const config = parseConfig();
  const models = config.models.map((model) => ({
    slug: model.id,
    name: model.name ?? KIMI_MODEL_DISPLAY_NAMES[model.id] ?? model.id,
    isCustom: false,
    capabilities: mapKimiCapabilities(model.capabilities),
  }));
  if (models.length === 0) {
    // Fallback when no models are configured in kimi.toml
    return [
      {
        slug: "kimi-code/kimi-for-coding",
        name: "Kimi for Coding",
        isCustom: false,
        capabilities: DEFAULT_KIMI_MODEL_CAPABILITIES,
      },
    ];
  }
  return models;
}

export function getKimiModelCapabilities(model: string | null | undefined): ModelCapabilities {
  const slug = model?.trim();
  const models = discoverKimiModels();
  return (
    models.find((candidate) => candidate.slug === slug)?.capabilities ??
    DEFAULT_KIMI_MODEL_CAPABILITIES
  );
}

const runKimiCommand = Effect.fn("runKimiCommand")(function* (args: ReadonlyArray<string>) {
  const kimiSettings = yield* Effect.service(ServerSettingsService).pipe(
    Effect.flatMap((service) => service.getSettings),
    Effect.map((settings) => settings.providers.kimi),
  );
  const command = ChildProcess.make(kimiSettings.binaryPath, [...args], {
    shell: process.platform === "win32",
  });
  return yield* spawnAndCollect(kimiSettings.binaryPath, command);
});

export const checkKimiProviderStatus = Effect.fn("checkKimiProviderStatus")(
  function* (): Effect.fn.Return<
    ServerProvider,
    ServerSettingsError,
    ChildProcessSpawner.ChildProcessSpawner | ServerSettingsService
  > {
    const kimiSettings = yield* Effect.service(ServerSettingsService).pipe(
      Effect.flatMap((service) => service.getSettings),
      Effect.map((settings) => settings.providers.kimi),
    );
    const checkedAt = new Date().toISOString();
    const discoveredModels = discoverKimiModels();
    const models = providerModelsFromSettings(
      discoveredModels,
      PROVIDER,
      kimiSettings.customModels,
      DEFAULT_KIMI_MODEL_CAPABILITIES,
    );

    if (!kimiSettings.enabled) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Kimi is disabled in T3 Code settings.",
        },
      });
    }

    const versionProbe = yield* runKimiCommand(["--version"]).pipe(
      Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(versionProbe)) {
      const error = versionProbe.failure;
      return buildServerProvider({
        provider: PROVIDER,
        enabled: kimiSettings.enabled,
        checkedAt,
        models,
        probe: {
          installed: !isCommandMissingCause(error),
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: isCommandMissingCause(error)
            ? "Kimi CLI (`kimi`) is not installed or not on PATH."
            : `Failed to execute Kimi CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
        },
      });
    }

    if (Option.isNone(versionProbe.success)) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: kimiSettings.enabled,
        checkedAt,
        models,
        probe: {
          installed: true,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: "Kimi CLI is installed but failed to run. Timed out while running command.",
        },
      });
    }

    const version = versionProbe.success.value;
    const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);
    if (version.code !== 0) {
      const detail = detailFromResult(version);
      return buildServerProvider({
        provider: PROVIDER,
        enabled: kimiSettings.enabled,
        checkedAt,
        models,
        probe: {
          installed: true,
          version: parsedVersion,
          status: "error",
          auth: { status: "unknown" },
          message: detail
            ? `Kimi CLI is installed but failed to run. ${detail}`
            : "Kimi CLI is installed but failed to run.",
        },
      });
    }

    // Auth check: Kimi uses API-key auth. isLoggedIn checks the local config.
    const authStatus: ServerProviderAuth = yield* Effect.sync(() => {
      try {
        const loggedIn = isLoggedIn();
        return loggedIn
          ? { status: "authenticated" as const }
          : { status: "unauthenticated" as const };
      } catch {
        return { status: "unknown" as const };
      }
    }).pipe(Effect.orElseSucceed(() => ({ status: "unknown" as const })));

    const status: Exclude<ServerProviderState, "disabled"> =
      authStatus.status === "authenticated" ? "ready" : "error";

    return buildServerProvider({
      provider: PROVIDER,
      enabled: kimiSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: parsedVersion,
        status,
        auth: authStatus,
        ...(authStatus.status === "unauthenticated"
          ? {
              message:
                "Kimi is not authenticated. Run `kimi` and send `/login` to configure your API key, or set KIMI_API_KEY.",
            }
          : {}),
      },
    });
  },
);

export const KimiProviderLive = Layer.effect(
  KimiProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const checkProvider = checkKimiProviderStatus().pipe(
      Effect.provideService(ServerSettingsService, serverSettings),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    return yield* makeManagedServerProvider<KimiSettings>({
      getSettings: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.kimi),
        Effect.orDie,
      ),
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => settings.providers.kimi),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      checkProvider,
    });
  }),
);

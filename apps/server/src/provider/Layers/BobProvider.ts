import {
  type BobSettings,
  type CustomModelSetting,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import {
  BOB_API_KEY_ENV,
  BOB_DEFAULT_MODEL_SLUG,
  makeBobAcpRuntime,
  resolveBobAcpBaseModelId,
} from "../acp/BobAcpSupport.ts";
import { sessionModelStateFromInitialize } from "../acp/AcpRuntimeModel.ts";
import { HttpClient } from "effect/unstable/http";

const BOB_PRESENTATION = {
  displayName: "Bob",
  supportsConversationRollback: false,
  showInteractionModeToggle: false,
  supportsTextGeneration: true,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
// `initialize` is a single local round trip.
const BOB_ACP_INITIALIZE_TIMEOUT_MS = 8_000;

const BOB_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: BOB_DEFAULT_MODEL_SLUG,
    name: "Bob",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

function bobModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = BOB_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

/** Models advertised by the ACP agent at initialize. */
function buildBobModelsFromAcpInitialize(
  modelState: ReturnType<typeof sessionModelStateFromInitialize>,
): ReadonlyArray<ServerProviderModel> {
  if (!modelState || modelState.availableModels.length === 0) {
    return [];
  }
  const currentModelId = modelState.currentModelId.trim();
  const seen = new Set<string>();
  return modelState.availableModels.flatMap((model): ServerProviderModel[] => {
    const slug = resolveBobAcpBaseModelId(model.modelId);
    if (!slug || seen.has(slug)) return [];
    seen.add(slug);
    return [
      {
        slug,
        name: model.name.trim() || slug,
        isCustom: false,
        ...(model.modelId.trim() === currentModelId ? { isDefault: true } : {}),
        capabilities: EMPTY_CAPABILITIES,
      },
    ];
  });
}

export function buildInitialBobProviderSnapshot(
  bobSettings: BobSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = bobModelsFromSettings(bobSettings.customModels);

    if (!bobSettings.enabled) {
      return buildServerProvider({
        presentation: BOB_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Bob is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: BOB_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Bob CLI availability...",
      },
    });
  });
}

const runBobCliCommand = (
  bobSettings: BobSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = bobSettings.binaryPath || "bob";
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

/**
 * Reads model metadata from `initialize` without authenticating or opening a
 * session — probes cannot trigger a browser login or boot MCP servers.
 */
const discoverBobMetadataViaAcpInitialize = (
  bobSettings: BobSettings,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeBobAcpRuntime({
      bobSettings,
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    const initialized = yield* acp.initialize();
    return {
      models: buildBobModelsFromAcpInitialize(sessionModelStateFromInitialize(initialized)),
      slashCommands: [COMPACT_SLASH_COMMAND],
    };
  }).pipe(Effect.scoped);

export const checkBobProviderStatus = Effect.fn("checkBobProviderStatus")(function* (
  bobSettings: BobSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = bobModelsFromSettings(bobSettings.customModels);

  if (!bobSettings.enabled) {
    return buildServerProvider({
      presentation: BOB_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Bob is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runBobCliCommand(bobSettings, ["--version"], environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Bob CLI health check failed.", { errorTag: error._tag });
    return buildServerProvider({
      presentation: BOB_PRESENTATION,
      enabled: bobSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Bob CLI (`bob`) is not installed or not on PATH."
          : "Failed to execute Bob CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: BOB_PRESENTATION,
      enabled: bobSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Bob CLI is installed but timed out while running `bob --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);

  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Bob CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
    });
    return buildServerProvider({
      presentation: BOB_PRESENTATION,
      enabled: bobSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Bob CLI is installed but failed to run.",
      },
    });
  }

  // Determine auth state. If the API key is set in the environment, we treat
  // the user as authenticated. Otherwise we defer to what the ACP probe says.
  const hasApiKey = Boolean(environment[BOB_API_KEY_ENV]?.trim());

  const acpExit = yield* discoverBobMetadataViaAcpInitialize(bobSettings, environment).pipe(
    Effect.timeoutOption(BOB_ACP_INITIALIZE_TIMEOUT_MS),
    Effect.exit,
  );
  const acpMetadata = Exit.isSuccess(acpExit) ? Option.getOrUndefined(acpExit.value) : undefined;
  const acpFailed = Exit.isFailure(acpExit) || Option.isNone(acpExit.value);

  if (acpFailed) {
    yield* Effect.logWarning("Bob ACP initialize probe failed or timed out.", {
      errorTag: Exit.isFailure(acpExit) ? causeErrorTag(acpExit.cause) : "Timeout",
    });
  }

  const acpModels = acpMetadata?.models ?? [];
  const discoveredModels = acpModels.length > 0 ? acpModels : [];
  const models =
    discoveredModels.length > 0
      ? bobModelsFromSettings(bobSettings.customModels, discoveredModels)
      : fallbackModels;

  const auth: ServerProviderAuth = hasApiKey
    ? { status: "authenticated", type: "api_key", label: "Bob API key" }
    : acpFailed
      ? { status: "unknown" }
      : { status: "authenticated", type: "cached_token", label: "IBM SSO" };

  return buildServerProvider({
    presentation: BOB_PRESENTATION,
    enabled: bobSettings.enabled,
    checkedAt,
    models,
    slashCommands: acpMetadata?.slashCommands ?? [COMPACT_SLASH_COMMAND],
    probe: {
      installed: true,
      version,
      status: acpFailed ? "warning" : "ready",
      auth,
      ...(acpFailed
        ? {
            message:
              "Bob CLI is installed but ACP initialize failed. Model options may be incomplete.",
          }
        : {}),
    },
  });
});

export const enrichBobSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Bob version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};

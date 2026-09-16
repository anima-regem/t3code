import { type BobSettings, ProviderDriverKind, type RuntimeMode } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

/**
 * Environment variable that, when set, is forwarded to the Bob Shell process as
 * BOBSHELL_API_KEY, bypassing the SSO browser flow.
 */
export const BOB_API_KEY_ENV = "BOBSHELL_API_KEY";

/**
 * ACP authenticate method used when no API key is present — Bob Shell opens
 * an IBM SSO browser page and stores the resulting token locally.
 */
export const BOB_AUTH_METHOD_SSO = "sso";

/**
 * ACP authenticate method used when BOBSHELL_API_KEY is set in the process
 * environment forwarded to the Bob Shell process.
 */
export const BOB_AUTH_METHOD_API_KEY = "api_key";

const BOB_DRIVER_KIND = ProviderDriverKind.make("bob");

type BobAcpRuntimeBobSettings = Pick<BobSettings, "binaryPath">;

/**
 * Returns the extra CLI args to pass after `bob acp` for a given runtime mode.
 * Bob Shell maps permissions via --auto-approve; workspace trust is handled by
 * always passing --trust since T3 Code users explicitly choose the project.
 */
export function bobAcpSpawnArgs(runtimeMode?: RuntimeMode): ReadonlyArray<string> {
  const base = ["acp", "--trust"];
  switch (runtimeMode) {
    case "auto":
    case "full-access":
      return [...base, "--auto-approve"];
    case "auto-accept-edits":
    case "approval-required":
    default:
      return base;
  }
}

export function buildBobAcpSpawnInput(
  bobSettings: BobAcpRuntimeBobSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  runtimeMode?: RuntimeMode,
): AcpSessionRuntime.AcpSpawnInput {
  const apiKey = environment?.[BOB_API_KEY_ENV]?.trim();
  return {
    command: bobSettings?.binaryPath || "bob",
    args: [...bobAcpSpawnArgs(runtimeMode)],
    cwd,
    env: {
      ...environment,
      // Forward only the Bob API key; never leak other secrets inadvertently.
      ...(apiKey ? { [BOB_API_KEY_ENV]: apiKey } : {}),
    },
  };
}

export function resolveBobAuthMethodId(environment: NodeJS.ProcessEnv | undefined): string {
  return environment?.[BOB_API_KEY_ENV]?.trim() ? BOB_AUTH_METHOD_API_KEY : BOB_AUTH_METHOD_SSO;
}

interface BobAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly bobSettings: BobAcpRuntimeBobSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeMode?: RuntimeMode;
}

export const makeBobAcpRuntime = (
  input: BobAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildBobAcpSpawnInput(
          input.bobSettings,
          input.cwd,
          input.environment,
          input.runtimeMode,
        ),
        authMethodId: resolveBobAuthMethodId(input.environment),
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

/**
 * T3's built-in Bob model slug. Selecting it means "use whatever model the
 * Bob session currently runs on" — T3 does not override the agent's default.
 */
export const BOB_DEFAULT_MODEL_SLUG = "bob-build";

export function resolveBobAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : BOB_DEFAULT_MODEL_SLUG;
}

/**
 * BobAdapter — ProviderAdapterShape for IBM Bob Shell via ACP.
 *
 * Bob speaks standard ACP over stdio (`bob acp`). This adapter is
 * intentionally simpler than GrokAdapter: no XAi extensions, no plan-mode,
 * no liveness watchdog. Permissions flow through the standard ACP
 * `session/request_permission` callback, same as Antigravity and Grok.
 *
 * @module provider/Layers/BobAdapter
 */
import {
  ApprovalRequestId,
  type BobSettings,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpSchema from "effect-acp/schema";
import * as EffectAcpErrors from "effect-acp/errors";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import {
  makeBobAcpRuntime,
  resolveBobAcpBaseModelId,
  BOB_DEFAULT_MODEL_SLUG,
} from "../acp/BobAcpSupport.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

const PROVIDER = ProviderDriverKind.make("bob");
const BOB_RESUME_VERSION = 1 as const;

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface BobAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: ProviderInstanceId;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

type PendingUserInputResolution =
  | { readonly _tag: "answered"; readonly answers: ProviderUserInputAnswers }
  | { readonly _tag: "cancelled" };

interface PendingUserInput {
  readonly resolution: Deferred.Deferred<PendingUserInputResolution>;
}

interface BobSessionContext {
  readonly threadId: ThreadId;
  readonly acpSessionId: string;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  activeTurnId: TurnId | undefined;
  promptsInFlight: number;
  promptEpoch: number;
  discardBeforeEpoch: number;
  readonly promptLifecycle: Semaphore.Semaphore;
  currentModelId: string | undefined;
  stopped: boolean;
}

function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingApprovals.values()),
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    { discard: true },
  );
}

function settlePendingUserInputsAsCancelled(
  pendingUserInputs: ReadonlyMap<ApprovalRequestId, PendingUserInput>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingUserInputs.values()),
    (pending) => Deferred.succeed(pending.resolution, { _tag: "cancelled" }).pipe(Effect.ignore),
    { discard: true },
  );
}

function parseBobResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== BOB_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
}

function selectBobPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: Exclude<ProviderApprovalDecision, "cancel">,
): string | undefined {
  const preferredKind =
    decision === "acceptForSession"
      ? "allow_always"
      : decision === "accept"
        ? "allow_once"
        : "reject_once";
  const preferred = request.options.find((entry) => entry.kind === preferredKind);
  const preferredId = preferred?.optionId.trim();
  if (preferredId) return preferredId;
  // Fall back to allow_once for acceptForSession if allow_always is not advertised.
  if (decision === "acceptForSession") {
    const once = request.options.find((entry) => entry.kind === "allow_once");
    return once?.optionId.trim();
  }
  return undefined;
}

export function makeBobAdapter(bobSettings: BobSettings, options?: BobAdapterLiveOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("bob");
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const crypto = yield* Crypto.Crypto;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const makeAcpNativeLoggers = yield* makeAcpNativeLoggerFactory();

    const sessions = new Map<ThreadId, BobSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate Bob runtime identifier.",
            cause,
          }),
      ),
    );
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const mapAcpCallbackFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new EffectAcpErrors.AcpTransportError({
              detail: "Failed to process Bob ACP callback.",
              cause,
            }),
        ),
      );

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing = Option.fromNullishOr(current.get(threadId));
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<BobSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const stopSessionInternal = (ctx: BobSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsCancelled(ctx.pendingUserInputs);
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const settlePromptInFlight = (
      threadId: ThreadId,
      turnId: TurnId,
      expectedAcpSessionId: string,
      options?: {
        readonly errorMessage?: string;
        readonly completedStopReason?: EffectAcpSchema.StopReason | null;
        readonly emitTurnCompletion?: boolean;
        readonly settleAllPrompts?: boolean;
      },
    ) =>
      Effect.gen(function* () {
        const liveCtx = sessions.get(threadId);
        if (!liveCtx) return;
        if (liveCtx.acpSessionId !== expectedAcpSessionId) return;

        if (options?.settleAllPrompts) {
          liveCtx.promptsInFlight = 0;
        } else {
          const remaining = Math.max(0, liveCtx.promptsInFlight - 1);
          if (
            remaining > 0 ||
            liveCtx.activeTurnId !== turnId ||
            liveCtx.session.activeTurnId !== turnId
          ) {
            liveCtx.promptsInFlight = remaining;
            return;
          }
          liveCtx.promptsInFlight = remaining;
        }

        const updatedAt = yield* nowIso;
        const canEmit =
          liveCtx.session.status === "running" || liveCtx.session.status === "connecting";
        const { activeTurnId: _activeTurnId, ...readySession } = liveCtx.session;
        liveCtx.activeTurnId = undefined;
        liveCtx.session = { ...readySession, status: "ready", updatedAt };

        if (options?.emitTurnCompletion === false) return;

        if (options?.errorMessage !== undefined && canEmit) {
          yield* offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId,
            turnId,
            payload: { state: "failed", errorMessage: options.errorMessage },
          });
        } else if (options?.completedStopReason !== undefined && canEmit) {
          yield* offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId,
            turnId,
            payload: {
              state: options.completedStopReason === "cancelled" ? "cancelled" : "completed",
              stopReason: options.completedStopReason ?? null,
            },
          });
        }
      });

    type BobAdapterError =
      | ProviderAdapterProcessError
      | ProviderAdapterRequestError
      | ProviderAdapterSessionClosedError
      | ProviderAdapterSessionNotFoundError
      | ProviderAdapterValidationError;

    const startSession: ProviderAdapterShape<BobAdapterError>["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }

          const cwd = path.resolve(input.cwd.trim());
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
          const sessionApprovedOperations = new Set<string>();
          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );

          const resumeSessionId = parseBobResume(input.resumeCursor)?.sessionId;
          const acpNativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
          });

          const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
          const acp = yield* makeBobAcpRuntime({
            bobSettings,
            ...(options?.environment || mcpSession?.agentDeviceEnvironment
              ? {
                  environment: McpProviderSession.withAgentDeviceEnvironment(
                    options?.environment ?? process.env,
                    mcpSession,
                  ),
                }
              : {}),
            childProcessSpawner,
            cwd,
            runtimeMode: input.runtimeMode,
            ...(resumeSessionId ? { resumeSessionId } : {}),
            clientInfo: { name: "t3-code", version: "0.0.0" },
            ...(mcpSession
              ? {
                  mcpServers: [
                    {
                      type: "http" as const,
                      name: "t3-code",
                      url: mcpSession.endpoint,
                      headers: [
                        {
                          name: "Authorization",
                          value: mcpSession.authorizationHeader,
                        },
                      ],
                    },
                  ],
                }
              : {}),
            ...acpNativeLoggers,
          }).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: cause.message,
                  cause,
                }),
            ),
          );

          const started = yield* Effect.gen(function* () {
            yield* acp.handleRequestPermission((params) =>
              mapAcpCallbackFailure(
                Effect.gen(function* () {
                  const permissionRequest = parsePermissionRequest(params);
                  const command = permissionRequest.toolCall?.command;
                  const { kind, title, rawInput, locations } = params.toolCall;
                  let operationInput = rawInput;
                  if (isRecord(rawInput) && rawInput.variant === "Bash") {
                    const { description: _description, ...shellInput } = rawInput;
                    operationInput = shellInput;
                  }
                  const approvalKey =
                    command || (isRecord(rawInput) && Object.keys(rawInput).length > 0)
                      ? stableStringify({ kind, title, command, input: operationInput, locations })
                      : undefined;
                  const alreadyApproved =
                    approvalKey !== undefined && sessionApprovedOperations.has(approvalKey);

                  if (input.runtimeMode === "full-access" || alreadyApproved) {
                    const autoOptionId =
                      input.runtimeMode === "full-access"
                        ? (selectBobPermissionOptionId(params, "acceptForSession") ??
                          selectBobPermissionOptionId(params, "accept"))
                        : selectBobPermissionOptionId(params, "accept");
                    if (autoOptionId !== undefined) {
                      return { outcome: { outcome: "selected" as const, optionId: autoOptionId } };
                    }
                  }

                  const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                  const runtimeRequestId = RuntimeRequestId.make(requestId);
                  const decision = yield* Deferred.make<ProviderApprovalDecision>();
                  const turnId = sessions.get(input.threadId)?.activeTurnId;
                  pendingApprovals.set(requestId, { decision });
                  yield* offerRuntimeEvent(
                    makeAcpRequestOpenedEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId,
                      requestId: runtimeRequestId,
                      permissionRequest,
                      detail:
                        permissionRequest.detail ??
                        encodeJsonStringForDiagnostics(params)?.slice(0, 2000) ??
                        "[unserializable params]",
                      args: params,
                      source: "acp.jsonrpc",
                      method: "session/request_permission",
                      rawPayload: params,
                    }),
                  );
                  const resolved = yield* Deferred.await(decision);
                  pendingApprovals.delete(requestId);
                  yield* offerRuntimeEvent(
                    makeAcpRequestResolvedEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId,
                      requestId: runtimeRequestId,
                      permissionRequest,
                      decision: resolved,
                    }),
                  );
                  const selectedOptionId =
                    resolved === "cancel"
                      ? undefined
                      : selectBobPermissionOptionId(params, resolved);
                  if (
                    resolved === "acceptForSession" &&
                    selectedOptionId &&
                    approvalKey !== undefined
                  ) {
                    sessionApprovedOperations.add(approvalKey);
                  }
                  return {
                    outcome: selectedOptionId
                      ? { outcome: "selected" as const, optionId: selectedOptionId }
                      : ({ outcome: "cancelled" } as const),
                  };
                }),
              ),
            );
            return yield* acp.start();
          }).pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
            ),
          );

          const now = yield* nowIso;
          const initialModelId =
            started.sessionSetupResult.models?.currentModelId?.trim() || undefined;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            ...(initialModelId ? { model: resolveBobAcpBaseModelId(initialModelId) } : {}),
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: BOB_RESUME_VERSION,
              sessionId: started.sessionId,
            },
            createdAt: now,
            updatedAt: now,
          };

          const ctx: BobSessionContext = {
            threadId: input.threadId,
            acpSessionId: started.sessionId,
            session,
            scope: sessionScope,
            acp,
            pendingApprovals,
            pendingUserInputs,
            turns: [],
            activeTurnId: undefined,
            promptsInFlight: 0,
            promptEpoch: 0,
            discardBeforeEpoch: 0,
            promptLifecycle: yield* Semaphore.make(1),
            currentModelId: initialModelId,
            stopped: false,
          };

          const nf = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                if (event._tag === "EventStreamBarrier") {
                  yield* Deferred.succeed(event.acknowledge, undefined);
                  return;
                }
                if (event._tag === "ModeChanged") return;

                const notificationTurnId = ctx.activeTurnId;
                if (notificationTurnId === undefined) return;

                const stamp = yield* makeEventStamp();
                switch (event._tag) {
                  case "AssistantItemStarted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp,
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: notificationTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.started",
                      }),
                    );
                    return;
                  case "AssistantItemCompleted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp,
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: notificationTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.completed",
                      }),
                    );
                    return;
                  case "ToolCallUpdated":
                    yield* offerRuntimeEvent(
                      makeAcpToolCallEvent({
                        stamp,
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: notificationTurnId,
                        toolCall: event.toolCall,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "ThoughtDelta":
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp,
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: notificationTurnId,
                        streamKind: "reasoning_text",
                        text: event.text,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "ContentDelta":
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp,
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: notificationTurnId,
                        ...(event.itemId ? { itemId: event.itemId } : {}),
                        text: event.text,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "ConnectionTerminated":
                    if (ctx.activeTurnId) {
                      yield* settlePromptInFlight(
                        ctx.threadId,
                        ctx.activeTurnId,
                        ctx.acpSessionId,
                        {
                          errorMessage: `Bob ACP connection terminated: ${event.error.message}`,
                          settleAllPrompts: true,
                        },
                      );
                    }
                    return;
                  default:
                    return;
                }
              }),
            ),
          ).pipe(
            Effect.catch((cause) =>
              Effect.logError("Failed to process Bob runtime notification.", { cause }),
            ),
            Effect.forkIn(ctx.scope),
          );
          void nf; // nf is unused by design — the fiber runs in the session scope
          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: started.initializeResult },
          });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: "Bob ACP session ready" },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });

          return session;
        }).pipe(Effect.scoped),
      );

    const sendTurn: ProviderAdapterShape<BobAdapterError>["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const prepared = yield* withThreadLock(
          input.threadId,
          Effect.gen(function* () {
            const ctx = yield* requireSession(input.threadId);
            const turnId = TurnId.make(yield* randomUUIDv4);
            ctx.promptsInFlight += 1;
            ctx.promptEpoch += 1;
            const promptEpoch = ctx.promptEpoch;
            ctx.activeTurnId = turnId;
            ctx.session = {
              ...ctx.session,
              status: "connecting",
              activeTurnId: turnId,
              updatedAt: yield* nowIso,
            };

            return yield* Effect.gen(function* () {
              const text = input.input?.trim();
              const imagePromptParts = yield* Effect.forEach(
                (input.attachments ?? []).filter((a) => a.type === "image"),
                (attachment) =>
                  Effect.gen(function* () {
                    const attachmentPath = resolveAttachmentPath({
                      attachmentsDir: serverConfig.attachmentsDir,
                      attachment,
                    });
                    if (!attachmentPath) {
                      return yield* new ProviderAdapterRequestError({
                        provider: PROVIDER,
                        method: "session/prompt",
                        detail: `Invalid attachment id '${attachment.id}'.`,
                      });
                    }
                    const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
                      Effect.mapError(
                        (cause) =>
                          new ProviderAdapterRequestError({
                            provider: PROVIDER,
                            method: "session/prompt",
                            detail: cause.message,
                            cause,
                          }),
                      ),
                    );
                    return {
                      type: "image" as const,
                      data: Buffer.from(bytes).toString("base64"),
                      mimeType: attachment.mimeType,
                    } satisfies EffectAcpSchema.ContentBlock;
                  }),
              );

              const promptParts: Array<EffectAcpSchema.ContentBlock> = [
                ...(text ? [{ type: "text" as const, text }] : []),
                ...imagePromptParts,
              ];

              if (promptParts.length === 0) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "sendTurn",
                  issue: "Turn requires non-empty text or attachments.",
                });
              }

              const displayModel = ctx.currentModelId
                ? resolveBobAcpBaseModelId(ctx.currentModelId)
                : BOB_DEFAULT_MODEL_SLUG;

              const runtimeInstructions =
                text && /^\/[^\s/]+(?:\s|$)/.test(text)
                  ? undefined
                  : buildRuntimeInstructions({ harness: "Bob", model: displayModel });

              ctx.session = {
                ...ctx.session,
                status: "running",
                activeTurnId: turnId,
                updatedAt: yield* nowIso,
                model: displayModel,
              };

              yield* offerRuntimeEvent({
                type: "turn.started",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                payload: { model: displayModel },
              });

              return {
                acp: ctx.acp,
                acpSessionId: ctx.acpSessionId,
                promptParts,
                runtimeInstructions,
                turnId,
                promptEpoch,
                promptLifecycle: ctx.promptLifecycle,
              };
            }).pipe(
              Effect.tapCause(() =>
                Effect.gen(function* () {
                  const liveCtx = sessions.get(input.threadId);
                  if (!liveCtx) return;
                  yield* settlePromptInFlight(input.threadId, turnId, liveCtx.acpSessionId, {
                    errorMessage: "Bob prompt preparation failed.",
                    emitTurnCompletion: false,
                  });
                }),
              ),
            );
          }),
        );

        const promptSettled = yield* Ref.make(false);

        return yield* Effect.gen(function* () {
          const promptStart = yield* prepared.promptLifecycle.withPermit(
            Effect.gen(function* () {
              const liveCtx = sessions.get(input.threadId);
              if (
                !liveCtx ||
                liveCtx.acpSessionId !== prepared.acpSessionId ||
                prepared.promptEpoch < liveCtx.discardBeforeEpoch
              ) {
                return { _tag: "Skipped" as const };
              }
              const dispatched = yield* Deferred.make<void>();
              const fiber = yield* liveCtx.acp
                .prompt(
                  {
                    prompt: [
                      ...prepared.promptParts,
                      ...(prepared.runtimeInstructions
                        ? [{ type: "text" as const, text: prepared.runtimeInstructions }]
                        : []),
                    ],
                  },
                  { dispatched },
                )
                .pipe(Effect.forkChild({ startImmediately: true }));
              yield* Effect.raceFirst(
                Deferred.await(dispatched),
                Fiber.await(fiber).pipe(Effect.asVoid),
              );
              return { _tag: "Started" as const, fiber };
            }),
          );

          if (promptStart._tag === "Skipped") {
            yield* withThreadLock(
              input.threadId,
              settlePromptInFlight(input.threadId, prepared.turnId, prepared.acpSessionId, {
                emitTurnCompletion: false,
              }),
            );
            return { threadId: input.threadId, turnId: prepared.turnId };
          }

          const { fiber } = promptStart;
          const promptResult = yield* Fiber.join(fiber).pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
            ),
            Effect.exit,
          );
          yield* Ref.set(promptSettled, true);

          const liveCtx = sessions.get(input.threadId);
          if (liveCtx && liveCtx.acpSessionId === prepared.acpSessionId) {
            yield* liveCtx.acp.drainEvents;
            const stopReason = Exit.isSuccess(promptResult)
              ? (promptResult.value.stopReason ?? null)
              : null;
            const errorMessage = Exit.isFailure(promptResult)
              ? `Bob ACP prompt failed: ${mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", Exit.isFailure(promptResult) ? (promptResult.cause as never) : (undefined as never)).message}`
              : undefined;
            yield* withThreadLock(
              input.threadId,
              settlePromptInFlight(input.threadId, prepared.turnId, prepared.acpSessionId, {
                errorMessage,
                completedStopReason: errorMessage ? undefined : stopReason,
              }),
            );
          }

          return {
            threadId: input.threadId,
            turnId: prepared.turnId,
            resumeCursor: liveCtx?.session.resumeCursor,
          };
        });
      });

    const interruptTurn: ProviderAdapterShape<BobAdapterError>["interruptTurn"] = (
      threadId,
      turnId,
    ) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = sessions.get(threadId);
          if (!ctx || ctx.stopped) return;
          const activeTurnId = turnId ?? ctx.activeTurnId;
          if (!activeTurnId) return;
          yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
          yield* settlePendingUserInputsAsCancelled(ctx.pendingUserInputs);
          yield* ctx.acp.cancel.pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error),
            ),
            Effect.ignore,
          );
          yield* settlePromptInFlight(threadId, activeTurnId, ctx.acpSessionId, {
            completedStopReason: "cancelled",
            settleAllPrompts: true,
          });
        }),
      );

    const respondToRequest: ProviderAdapterShape<BobAdapterError>["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) return;
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: ProviderAdapterShape<BobAdapterError>["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingUserInputs.get(requestId);
        if (!pending) return;
        yield* Deferred.succeed(pending.resolution, { _tag: "answered", answers });
      });

    const stopSession: ProviderAdapterShape<BobAdapterError>["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = sessions.get(threadId);
          if (!ctx) return;
          yield* stopSessionInternal(ctx);
        }),
      );

    const stopAll = () =>
      Effect.forEach(
        Array.from(sessions.values()),
        (ctx) => stopSessionInternal(ctx).pipe(Effect.ignore),
        { discard: true },
      );

    const listSessions = () =>
      Effect.succeed(Array.from(sessions.values()).map((ctx) => ctx.session));

    const hasSession = (threadId: ThreadId) =>
      Effect.succeed(sessions.has(threadId) && !sessions.get(threadId)!.stopped);

    const readThread = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return {
          threadId,
          turns: ctx.turns.map((t) => ({ id: t.id, items: t.items })),
        };
      });

    const rollbackThread = (threadId: ThreadId, _numTurns: number) =>
      Effect.gen(function* () {
        // Bob does not support conversation rollback via ACP.
        const ctx = yield* requireSession(threadId);
        return {
          threadId,
          turns: ctx.turns.map((t) => ({ id: t.id, items: t.items })),
        };
      });

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "unsupported" as const,
        supportsConversationRollback: false,
      },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      stopAll,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies ProviderAdapterShape<BobAdapterError>;
  });
}

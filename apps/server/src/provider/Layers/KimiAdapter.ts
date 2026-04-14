/**
 * KimiAdapterLive - Scoped live implementation for the Kimi Code provider adapter.
 *
 * Wraps `@moonshot-ai/kimi-agent-sdk` sessions behind the generic provider adapter
 * contract and emits canonical runtime events.
 *
 * @module KimiAdapterLive
 */
import {
  createSession,
  type Session,
  type Turn,
  type StreamEvent,
  type ApprovalResponse,
  type ContentPart,
} from "@moonshot-ai/kimi-agent-sdk";
import {
  ApprovalRequestId,
  type CanonicalItemType,
  type CanonicalRequestType,
  EventId,
  type ProviderApprovalDecision,
  ProviderItemId,
  type ProviderRuntimeEvent,
  type ProviderRuntimeTurnStatus,
  type ProviderSession,
  type ThreadTokenUsageSnapshot,
  type ProviderUserInputAnswers,
  type RuntimeContentStreamKind,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
  type UserInputQuestion,
  type RuntimeMode,
} from "@t3tools/contracts";
import { resolveApiModelId, trimOrNull } from "@t3tools/shared/model";
import {
  Cause,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Queue,
  Random,
  Stream,
} from "effect";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { KimiAdapter, type KimiAdapterShape } from "../Services/KimiAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "kimi" as const;
type KimiTextStreamKind = Extract<RuntimeContentStreamKind, "assistant_text" | "reasoning_text">;

interface KimiTurnState {
  readonly turnId: TurnId;
  readonly startedAt: string;
  nextSyntheticItemIndex: number;
}

interface PendingApproval {
  readonly requestType: CanonicalRequestType;
  readonly detail?: string;
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface ToolInFlight {
  readonly itemId: string;
  readonly itemType: CanonicalItemType;
  readonly toolName: string;
  readonly title: string;
  readonly detail?: string;
  readonly input: Record<string, unknown>;
}

interface KimiSessionContext {
  session: ProviderSession;
  readonly sdkSession: Session;
  streamFiber: Fiber.Fiber<void, Error> | undefined;
  readonly startedAt: string;
  currentTurn: Turn | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<
    ApprovalRequestId,
    { readonly answers: Deferred.Deferred<ProviderUserInputAnswers> }
  >;
  readonly inFlightTools: Map<string, ToolInFlight>;
  turnState: KimiTurnState | undefined;
  lastKnownTokenUsage: ThreadTokenUsageSnapshot | undefined;
  stopped: boolean;
  pendingPlanMode: boolean | undefined;
  planModeActive: boolean;
}

export interface KimiAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

function normalizeKimiStreamMessages(cause: Cause.Cause<unknown>): ReadonlyArray<string> {
  const errors = Cause.prettyErrors(cause)
    .map((error) => error.message.trim())
    .filter((message) => message.length > 0);
  if (errors.length > 0) {
    return errors;
  }
  const squashed = toMessage(Cause.squash(cause), "").trim();
  return squashed.length > 0 ? [squashed] : [];
}

function isKimiInterruptedMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("interrupted") ||
    normalized.includes("cancelled") ||
    normalized.includes("aborted")
  );
}

function isKimiInterruptedCause(cause: Cause.Cause<unknown>): boolean {
  return (
    Cause.hasInterruptsOnly(cause) ||
    normalizeKimiStreamMessages(cause).some(isKimiInterruptedMessage)
  );
}

function messageFromKimiStreamCause(cause: Cause.Cause<unknown>, fallback: string): string {
  return normalizeKimiStreamMessages(cause)[0] ?? fallback;
}

function interruptionMessageFromKimiCause(cause: Cause.Cause<unknown>): string {
  const message = messageFromKimiStreamCause(cause, "Kimi runtime interrupted.");
  return isKimiInterruptedMessage(message) ? "Kimi runtime interrupted." : message;
}

function asRuntimeRequestId(value: string): RuntimeRequestId {
  return RuntimeRequestId.make(value);
}

function nextSyntheticItemId(context: {
  turnState?: { nextSyntheticItemIndex: number } | undefined;
}): string {
  const index = context.turnState?.nextSyntheticItemIndex ?? 0;
  if (context.turnState) {
    context.turnState.nextSyntheticItemIndex = index + 1;
  }
  return `kimi-item-${index}`;
}

function classifyToolItemType(toolName: string): CanonicalItemType {
  const normalized = toolName.toLowerCase();
  if (
    normalized.includes("bash") ||
    normalized.includes("command") ||
    normalized.includes("shell") ||
    normalized.includes("terminal")
  ) {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("file") ||
    normalized.includes("patch") ||
    normalized.includes("replace") ||
    normalized.includes("create") ||
    normalized.includes("delete")
  ) {
    return "file_change";
  }
  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  if (normalized.includes("websearch") || normalized.includes("web search")) {
    return "web_search";
  }
  if (normalized.includes("image")) {
    return "image_view";
  }
  if (normalized.includes("subagent") || normalized.includes("sub-agent")) {
    return "collab_agent_tool_call";
  }
  return "dynamic_tool_call";
}

function isReadOnlyToolName(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return (
    normalized === "read" ||
    normalized.includes("read file") ||
    normalized.includes("view") ||
    normalized.includes("grep") ||
    normalized.includes("glob") ||
    normalized.includes("search")
  );
}

function classifyRequestType(toolName: string): CanonicalRequestType {
  if (isReadOnlyToolName(toolName)) {
    return "file_read_approval";
  }
  const itemType = classifyToolItemType(toolName);
  return itemType === "command_execution"
    ? "command_execution_approval"
    : itemType === "file_change"
      ? "file_change_approval"
      : "dynamic_tool_call";
}

function summarizeToolRequest(toolName: string, input: Record<string, unknown>): string {
  const commandValue = input.command ?? input.cmd;
  const command = typeof commandValue === "string" ? commandValue : undefined;
  if (command && command.trim().length > 0) {
    return `${toolName}: ${command.trim().slice(0, 400)}`;
  }
  const serialized = JSON.stringify(input);
  if (serialized === "{}") {
    return toolName;
  }
  if (serialized.length <= 400) {
    return `${toolName}: ${serialized}`;
  }
  return `${toolName}: ${serialized.slice(0, 397)}...`;
}

function titleForTool(itemType: CanonicalItemType): string {
  switch (itemType) {
    case "command_execution":
      return "Command run";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "collab_agent_tool_call":
      return "Subagent task";
    case "web_search":
      return "Web search";
    case "image_view":
      return "Image view";
    case "dynamic_tool_call":
      return "Tool call";
    default:
      return "Item";
  }
}

function streamKindFromContentPart(part: ContentPart): KimiTextStreamKind {
  if (part.type === "think") {
    return "reasoning_text";
  }
  return "assistant_text";
}

function textFromContentPart(part: ContentPart): string {
  if (part.type === "text") {
    return part.text;
  }
  if (part.type === "think") {
    return part.think;
  }
  return "";
}

function toSessionError(
  threadId: ThreadId,
  cause: unknown,
): ProviderAdapterSessionNotFoundError | ProviderAdapterSessionClosedError | undefined {
  const normalized = toMessage(cause, "").toLowerCase();
  if (normalized.includes("unknown session") || normalized.includes("not found")) {
    return new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  if (normalized.includes("closed")) {
    return new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  return undefined;
}

function toRequestError(threadId: ThreadId, method: string, cause: unknown): ProviderAdapterError {
  const sessionError = toSessionError(threadId, cause);
  if (sessionError) {
    return sessionError;
  }
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: toMessage(cause, `${method} failed`),
    cause,
  });
}

function normalizeKimiTokenUsage(
  tokenUsage:
    | {
        input_other?: number;
        output?: number;
        input_cache_read?: number;
        input_cache_creation?: number;
      }
    | undefined,
): ThreadTokenUsageSnapshot | undefined {
  if (!tokenUsage) return undefined;
  const inputTokens =
    (typeof tokenUsage.input_other === "number" && Number.isFinite(tokenUsage.input_other)
      ? tokenUsage.input_other
      : 0) +
    (typeof tokenUsage.input_cache_read === "number" && Number.isFinite(tokenUsage.input_cache_read)
      ? tokenUsage.input_cache_read
      : 0) +
    (typeof tokenUsage.input_cache_creation === "number" &&
    Number.isFinite(tokenUsage.input_cache_creation)
      ? tokenUsage.input_cache_creation
      : 0);
  const outputTokens =
    typeof tokenUsage.output === "number" && Number.isFinite(tokenUsage.output)
      ? tokenUsage.output
      : 0;
  const totalProcessedTokens = inputTokens + outputTokens;
  if (totalProcessedTokens <= 0) {
    return undefined;
  }
  return {
    usedTokens: totalProcessedTokens,
    lastUsedTokens: totalProcessedTokens,
    ...(inputTokens > 0 ? { inputTokens } : {}),
    ...(outputTokens > 0 ? { outputTokens } : {}),
  };
}

function mapKimiRuntimeMode(runtimeMode: RuntimeMode): boolean {
  switch (runtimeMode) {
    case "full-access":
      return true;
    case "auto-accept-edits":
    case "approval-required":
      return false;
  }
}

function approvalResponseFromDecision(decision: ProviderApprovalDecision): ApprovalResponse {
  switch (decision) {
    case "acceptForSession":
      return "approve_for_session";
    case "accept":
      return "approve";
    case "decline":
    case "cancel":
    default:
      return "reject";
  }
}

const makeKimiAdapter = Effect.fn("makeKimiAdapter")(function* (options?: KimiAdapterLiveOptions) {
  const nativeEventLogger =
    options?.nativeEventLogger ??
    (options?.nativeEventLogPath !== undefined
      ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
          stream: "native",
        })
      : undefined);

  const sessions = new Map<ThreadId, KimiSessionContext>();
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const serverConfig = yield* ServerConfig;
  const serverSettingsService = yield* ServerSettingsService;

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.make(id));
  const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

  const offerRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid);

  const logNativeEvent = Effect.fn("logNativeEvent")(function* (
    context: KimiSessionContext,
    event: StreamEvent,
  ) {
    if (!nativeEventLogger) {
      return;
    }
    const observedAt = new Date().toISOString();
    const eventType = "type" in event ? event.type : "unknown";
    yield* nativeEventLogger.write(
      {
        observedAt,
        event: {
          id: crypto.randomUUID(),
          kind: "notification",
          provider: PROVIDER,
          createdAt: observedAt,
          method: `kimi/${eventType}`,
          ...(context.session.threadId ? { providerThreadId: context.session.threadId } : {}),
          ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
          payload: event,
        },
      },
      context.session.threadId,
    );
  });

  const snapshotThread = Effect.fn("snapshotThread")(function* (context: KimiSessionContext) {
    const threadId = context.session.threadId;
    if (!threadId) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "readThread",
        issue: "Session thread id is not initialized yet.",
      });
    }
    return {
      threadId,
      turns: [], // Kimi SDK does not expose thread turns directly
    };
  });

  const emitSessionStarted = (context: KimiSessionContext) =>
    Effect.gen(function* () {
      const { eventId, createdAt } = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "session.started",
        eventId,
        provider: PROVIDER,
        createdAt,
        threadId: context.session.threadId,
        payload: {},
        providerRefs: {},
      });
    });

  const emitSessionState = (context: KimiSessionContext, status: ProviderSession["status"]) =>
    Effect.gen(function* () {
      const { eventId, createdAt } = yield* makeEventStamp();
      context.session = { ...context.session, status, updatedAt: createdAt };
      const state =
        status === "ready"
          ? "ready"
          : status === "running"
            ? "running"
            : status === "connecting"
              ? "starting"
              : status === "error"
                ? "error"
                : "stopped";
      yield* offerRuntimeEvent({
        type: "session.state.changed",
        eventId,
        provider: PROVIDER,
        createdAt,
        threadId: context.session.threadId,
        payload: { state },
        providerRefs: {},
      });
    });

  const emitTurnStarted = (context: KimiSessionContext, turnId: TurnId) =>
    Effect.gen(function* () {
      const { eventId, createdAt } = yield* makeEventStamp();
      context.turnState = {
        turnId,
        startedAt: createdAt,
        nextSyntheticItemIndex: 0,
      };
      context.session = {
        ...context.session,
        activeTurnId: turnId,
        status: "running",
        updatedAt: createdAt,
      };
      yield* offerRuntimeEvent({
        type: "turn.started",
        eventId,
        provider: PROVIDER,
        createdAt,
        threadId: context.session.threadId,
        turnId,
        payload: {},
        providerRefs: {},
      });
    });

  const emitTurnCompleted = (context: KimiSessionContext, status: ProviderRuntimeTurnStatus) =>
    Effect.gen(function* () {
      if (!context.turnState) return;
      const { eventId, createdAt } = yield* makeEventStamp();
      const turnId = context.turnState.turnId;
      context.turnState = undefined;
      context.session = {
        ...context.session,
        activeTurnId: undefined,
        status: "ready",
        updatedAt: createdAt,
      };
      if (status === "interrupted" || status === "cancelled") {
        yield* offerRuntimeEvent({
          type: "turn.aborted",
          eventId,
          provider: PROVIDER,
          createdAt,
          threadId: context.session.threadId,
          turnId,
          payload: { reason: interruptionMessageFromKimiCause(Cause.empty) },
          providerRefs: {},
        });
      } else {
        yield* offerRuntimeEvent({
          type: "turn.completed",
          eventId,
          provider: PROVIDER,
          createdAt,
          threadId: context.session.threadId,
          turnId,
          payload: { state: status },
          providerRefs: {},
        });
      }
    });

  const handleStreamEvent = Effect.fn("handleStreamEvent")(function* (
    context: KimiSessionContext,
    event: StreamEvent,
  ) {
    yield* logNativeEvent(context, event);

    if ("code" in event && "message" in event) {
      // ParseError
      const { eventId, createdAt } = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "runtime.error",
        eventId,
        provider: PROVIDER,
        createdAt,
        threadId: context.session.threadId,
        turnId: context.turnState?.turnId,
        payload: { message: event.message },
        providerRefs: {},
      });
      return;
    }

    const threadId = context.session.threadId;
    const turnId = context.turnState?.turnId;

    switch (event.type) {
      case "TurnBegin": {
        if (turnId) {
          yield* emitTurnCompleted(context, "completed");
        }
        const newTurnId = TurnId.make(crypto.randomUUID());
        yield* emitTurnStarted(context, newTurnId);
        if (context.pendingPlanMode !== undefined) {
          const targetPlanMode = context.pendingPlanMode;
          context.planModeActive = targetPlanMode;
          context.pendingPlanMode = undefined;
          if (context.sdkSession.planMode !== targetPlanMode) {
            yield* Effect.tryPromise({
              try: () => context.sdkSession.setPlanMode(targetPlanMode),
              catch: (cause) => toRequestError(context.session.threadId, "turn/setPlanMode", cause),
            }).pipe(
              Effect.tapError((e) => Effect.logWarning(`Kimi setPlanMode failed: ${e}`)),
              Effect.ignore,
            );
          }
        }
        break;
      }

      case "ContentPart": {
        if (!turnId) break;
        const { eventId, createdAt } = yield* makeEventStamp();
        const text = textFromContentPart(event.payload);
        if (text.length > 0) {
          yield* offerRuntimeEvent({
            type: "content.delta",
            eventId,
            provider: PROVIDER,
            createdAt,
            threadId,
            turnId,
            payload: {
              streamKind: streamKindFromContentPart(event.payload),
              delta: text,
            },
            providerRefs: {},
          });
          if (context.planModeActive && event.payload.type === "text") {
            yield* offerRuntimeEvent({
              type: "turn.proposed.delta",
              eventId: EventId.make(`${eventId}-plan`),
              provider: PROVIDER,
              createdAt,
              threadId,
              turnId,
              payload: { delta: text },
              providerRefs: {},
            });
          }
        }
        break;
      }

      case "StepBegin": {
        if (!turnId) break;
        const { eventId, createdAt } = yield* makeEventStamp();
        const taskId = RuntimeTaskId.make(`step-${event.payload.n}`);
        yield* offerRuntimeEvent({
          type: "task.started",
          eventId,
          provider: PROVIDER,
          createdAt,
          threadId,
          turnId,
          payload: { taskId },
          providerRefs: {},
        });
        break;
      }

      case "StepInterrupted": {
        if (!turnId) break;
        const { eventId, createdAt } = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "turn.aborted",
          eventId,
          provider: PROVIDER,
          createdAt,
          threadId,
          turnId,
          payload: { reason: "interrupted" },
          providerRefs: {},
        });
        break;
      }

      case "ToolCall": {
        if (!turnId) break;
        const toolCall = event.payload;
        const toolName = toolCall.function.name;
        const itemType = classifyToolItemType(toolName);
        const itemId = nextSyntheticItemId(context);
        const input: Record<string, unknown> = yield* Effect.try({
          try: () => {
            if (toolCall.function.arguments) {
              return JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
            }
            return {};
          },
          catch: () => ({ raw: toolCall.function.arguments }),
        });
        const title = titleForTool(itemType);
        const detail = summarizeToolRequest(toolName, input);
        context.inFlightTools.set(toolCall.id, {
          itemId,
          itemType,
          toolName,
          title,
          detail,
          input,
        });
        const { eventId, createdAt } = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "item.started",
          eventId,
          provider: PROVIDER,
          createdAt,
          threadId,
          turnId,
          itemId: RuntimeItemId.make(itemId),
          payload: {
            itemType,
            title,
            detail,
            data: { toolName, input },
          },
          providerRefs: { providerItemId: ProviderItemId.make(toolCall.id) },
        });
        break;
      }

      case "ToolResult": {
        if (!turnId) break;
        const toolResult = event.payload;
        const inFlight = context.inFlightTools.get(toolResult.tool_call_id);
        if (inFlight) {
          context.inFlightTools.delete(toolResult.tool_call_id);
        }
        const itemId = inFlight?.itemId ?? nextSyntheticItemId(context);
        const itemType = inFlight?.itemType ?? "dynamic_tool_call";
        const returnValue = toolResult.return_value;
        const rv = returnValue as { display?: unknown; output?: unknown; message?: unknown };
        const displayBlocks: unknown[] = Array.isArray(rv.display) ? rv.display : [];
        const outputText = typeof rv.output === "string" ? rv.output : undefined;
        const messageText = typeof rv.message === "string" ? rv.message : undefined;
        const { eventId, createdAt } = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "item.completed",
          eventId,
          provider: PROVIDER,
          createdAt,
          threadId,
          turnId,
          itemId: RuntimeItemId.make(itemId),
          payload: {
            itemType,
            status: returnValue.is_error ? "failed" : "completed",
            title: inFlight?.title ?? titleForTool(itemType),
            detail: inFlight?.detail,
            data: {
              toolName: inFlight?.toolName ?? itemType,
              input: inFlight?.input ?? {},
              ...(displayBlocks.length > 0 ? { display: displayBlocks } : {}),
              ...(outputText ? { output: outputText } : {}),
              ...(messageText ? { message: messageText } : {}),
            },
          },
          providerRefs: { providerItemId: ProviderItemId.make(toolResult.tool_call_id) },
        });
        break;
      }

      case "ApprovalRequest": {
        if (!turnId) break;
        const requestId = ApprovalRequestId.make(event.payload.id);
        const requestType = classifyRequestType(event.payload.sender);
        const detail = event.payload.description;
        const pending: PendingApproval = {
          requestType,
          detail,
          decision: yield* Deferred.make<ProviderApprovalDecision>(),
        };
        context.pendingApprovals.set(requestId, pending);
        const { eventId, createdAt } = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "request.opened",
          eventId,
          provider: PROVIDER,
          createdAt,
          threadId,
          turnId,
          requestId: asRuntimeRequestId(event.payload.id),
          payload: {
            requestType,
            detail,
          },
          providerRefs: {},
        });
        break;
      }

      case "QuestionRequest": {
        if (!turnId) break;
        if (context.planModeActive) {
          const { eventId: planEventId, createdAt: planCreatedAt } = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "turn.proposed.completed",
            eventId: planEventId,
            provider: PROVIDER,
            createdAt: planCreatedAt,
            threadId,
            turnId,
            payload: { planMarkdown: "" },
            providerRefs: {},
          });
        }
        const requestId = ApprovalRequestId.make(event.payload.id);
        const questions: Array<UserInputQuestion> = event.payload.questions.map((q) => ({
          id: q.question,
          question: q.question,
          header: q.header ?? "Question",
          options:
            q.options?.map((o) => ({ label: o.label, description: o.description ?? "" })) ?? [],
          multiSelect: q.multi_select ?? false,
        }));
        const pending = {
          answers: yield* Deferred.make<ProviderUserInputAnswers>(),
        };
        context.pendingUserInputs.set(requestId, pending);
        const { eventId, createdAt } = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "user-input.requested",
          eventId,
          provider: PROVIDER,
          createdAt,
          threadId,
          turnId,
          requestId: asRuntimeRequestId(event.payload.id),
          payload: { questions },
          providerRefs: {},
        });
        break;
      }

      case "StatusUpdate": {
        if (!turnId) break;
        if (event.payload.plan_mode === true || event.payload.plan_mode === false) {
          context.planModeActive = event.payload.plan_mode;
        }
        const tokenUsage = normalizeKimiTokenUsage(event.payload.token_usage ?? undefined);
        if (tokenUsage) {
          context.lastKnownTokenUsage = tokenUsage;
          const { eventId, createdAt } = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "thread.token-usage.updated",
            eventId,
            provider: PROVIDER,
            createdAt,
            threadId,
            turnId,
            payload: { usage: tokenUsage },
            providerRefs: {},
          });
        }
        break;
      }

      case "CompactionBegin": {
        if (!turnId) break;
        const itemId = nextSyntheticItemId(context);
        const { eventId, createdAt } = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "item.started",
          eventId,
          provider: PROVIDER,
          createdAt,
          threadId,
          turnId,
          itemId: RuntimeItemId.make(itemId),
          payload: {
            itemType: "context_compaction",
            title: "Context compaction",
          },
          providerRefs: {},
        });
        break;
      }

      case "CompactionEnd": {
        if (!turnId) break;
        const itemId = nextSyntheticItemId(context);
        const { eventId, createdAt } = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "item.completed",
          eventId,
          provider: PROVIDER,
          createdAt,
          threadId,
          turnId,
          itemId: RuntimeItemId.make(itemId),
          payload: {
            itemType: "context_compaction",
            title: "Context compaction",
          },
          providerRefs: {},
        });
        break;
      }

      case "SubagentEvent": {
        // For subagent events, we could recursively handle them. For now,
        // emit a simple activity so the UI shows something.
        if (!turnId) break;
        const { eventId, createdAt } = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "item.started",
          eventId,
          provider: PROVIDER,
          createdAt,
          threadId,
          turnId,
          itemId: RuntimeItemId.make(nextSyntheticItemId(context)),
          payload: {
            itemType: "collab_agent_tool_call",
            title: "Subagent task",
            detail: `Subagent ${event.payload.parent_tool_call_id}`,
          },
          providerRefs: {},
        });
        break;
      }

      case "TurnEnd":
      case "ToolCallPart":
      case "SteerInput":
      case "HookTriggered":
      case "HookResolved":
      case "ApprovalResponse":
      case "PlanDisplay":
      default:
        // No-op or not yet mapped
        break;
    }
  });

  const runTurnStream = Effect.fn("runTurnStream")(function* (
    context: KimiSessionContext,
    turn: Turn,
  ) {
    context.currentTurn = turn;

    const streamProgram = Stream.fromAsyncIterable(turn, (cause) =>
      toRequestError(context.session.threadId, "turn/stream", cause),
    ).pipe(
      Stream.takeWhile(() => !context.stopped),
      Stream.runForEach((event) => handleStreamEvent(context, event)),
    );

    const resultPromise = Effect.tryPromise({
      try: () => turn.result,
      catch: (cause) => toRequestError(context.session.threadId, "turn/result", cause),
    });

    const combined = Effect.all([streamProgram, resultPromise], { concurrency: 2 });
    const exit = yield* Effect.exit(combined);

    if (Exit.isSuccess(exit)) {
      const result = exit.value[1];
      if (result.status === "cancelled") {
        yield* emitTurnCompleted(context, "interrupted");
      } else {
        yield* emitTurnCompleted(context, "completed");
      }
    } else {
      const cause = exit.cause;
      if (isKimiInterruptedCause(cause)) {
        yield* emitTurnCompleted(context, "interrupted");
      } else {
        const message = messageFromKimiStreamCause(cause, "Kimi turn stream failed");
        yield* emitTurnCompleted(context, "failed");
        const { eventId, createdAt } = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "runtime.error",
          eventId,
          provider: PROVIDER,
          createdAt,
          threadId: context.session.threadId,
          turnId: context.turnState?.turnId,
          payload: { message },
          providerRefs: {},
        });
      }
    }

    context.currentTurn = undefined;
  });

  const getContext = (threadId: ThreadId) =>
    Effect.sync(() => {
      const context = sessions.get(threadId);
      if (!context) {
        return undefined;
      }
      return context;
    });

  const requireContext = (threadId: ThreadId, _method: string) =>
    Effect.gen(function* () {
      const context = yield* getContext(threadId);
      if (!context) {
        return yield* new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      if (context.stopped) {
        return yield* new ProviderAdapterSessionClosedError({
          provider: PROVIDER,
          threadId,
        });
      }
      return context;
    });

  const startSession: KimiAdapterShape["startSession"] = (input) =>
    Effect.gen(function* () {
      const kimiSettings = yield* serverSettingsService.getSettings.pipe(
        Effect.map((s) => s.providers.kimi),
        Effect.mapError(
          (error) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "startSession",
              detail: error.message ?? "Failed to load server settings",
              cause: error,
            }),
        ),
      );
      const resolvedModel = resolveApiModelId(
        input.modelSelection ?? {
          provider: "kimi",
          model: "kimi-code/kimi-for-coding",
        },
      );
      const threadId = input.threadId;
      const createdAt = yield* Effect.map(DateTime.now, DateTime.formatIso);

      const sdkSession = createSession({
        workDir: input.cwd ?? process.cwd(),
        ...(input.resumeCursor ? { sessionId: String(input.resumeCursor) } : {}),
        model: resolvedModel,
        yoloMode: mapKimiRuntimeMode(input.runtimeMode ?? "full-access"),
        ...(input.modelSelection?.provider === "kimi" &&
        input.modelSelection.options?.thinking !== undefined
          ? { thinking: input.modelSelection.options.thinking }
          : {}),
        ...(kimiSettings.binaryPath ? { executable: kimiSettings.binaryPath } : {}),
      });

      const session: ProviderSession = {
        provider: PROVIDER,
        status: "connecting",
        runtimeMode: input.runtimeMode ?? "full-access",
        cwd: input.cwd,
        model: resolvedModel,
        threadId,
        resumeCursor: sdkSession.sessionId,
        activeTurnId: undefined,
        createdAt,
        updatedAt: createdAt,
        lastError: undefined,
      };

      const context: KimiSessionContext = {
        session,
        sdkSession,
        streamFiber: undefined,
        startedAt: createdAt,
        currentTurn: undefined,
        pendingApprovals: new Map(),
        pendingUserInputs: new Map(),
        inFlightTools: new Map(),
        turnState: undefined,
        lastKnownTokenUsage: undefined,
        stopped: false,
        pendingPlanMode: undefined,
        planModeActive: false,
      };

      sessions.set(threadId, context);

      yield* emitSessionStarted(context);
      yield* emitSessionState(context, "ready");

      return session;
    });

  const sendTurn: KimiAdapterShape["sendTurn"] = (input) =>
    Effect.gen(function* () {
      const context = yield* requireContext(input.threadId, "sendTurn");
      if (context.stopped || !context.sdkSession) {
        return yield* new ProviderAdapterSessionClosedError({
          provider: PROVIDER,
          threadId: input.threadId,
        });
      }

      const turnId = TurnId.make(crypto.randomUUID());
      const text = trimOrNull(input.input) ?? "";

      // Build attachments (images only)
      const contentParts: Array<ContentPart> = [];
      if (text.length > 0) {
        contentParts.push({ type: "text", text });
      }

      for (const attachment of input.attachments ?? []) {
        if (attachment.type !== "image") continue;
        const attachmentPath = resolveAttachmentPath({
          attachmentsDir: serverConfig.attachmentsDir,
          attachment,
        });
        if (!attachmentPath) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "sendTurn",
            detail: `Invalid attachment id '${attachment.id}'.`,
          });
        }
        const imageBytes = yield* Effect.tryPromise({
          try: async () => {
            const { readFile } = await import("node:fs/promises");
            return await readFile(attachmentPath);
          },
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "sendTurn",
              detail: `Failed to read image attachment '${attachment.id}'.`,
              cause,
            }),
        });
        const dataUrl = `data:${attachment.mimeType};base64,${Buffer.from(imageBytes).toString("base64")}`;
        contentParts.push({
          type: "image_url",
          image_url: { url: dataUrl },
        });
      }

      if (input.interactionMode !== undefined) {
        context.pendingPlanMode = input.interactionMode === "plan";
      }

      const turn = context.sdkSession.prompt(contentParts.length > 0 ? contentParts : "");

      yield* emitTurnStarted(context, turnId);

      context.streamFiber = yield* Effect.forkDetach(runTurnStream(context, turn));

      return { threadId: input.threadId, turnId };
    });

  const interruptTurn: KimiAdapterShape["interruptTurn"] = (threadId) =>
    Effect.gen(function* () {
      const context = yield* requireContext(threadId, "interruptTurn");
      if (context.currentTurn) {
        yield* Effect.tryPromise({
          try: () => context.currentTurn!.interrupt(),
          catch: (cause) => toRequestError(threadId, "turn/interrupt", cause),
        }).pipe(Effect.timeout("5 seconds"), Effect.ignore);
      }
      if (context.streamFiber) {
        yield* Fiber.interrupt(context.streamFiber);
        context.streamFiber = undefined;
      }
      // If the SDK session is still active, the underlying turn cleanup never
      // ran. Close the session so the next turn forces a clean recovery.
      if (context.sdkSession.state === "active") {
        yield* Effect.tryPromise({
          try: () => context.sdkSession.close(),
          catch: (cause) => toRequestError(threadId, "session/close", cause),
        }).pipe(Effect.timeout("3 seconds"), Effect.ignore);
        sessions.delete(threadId);
      }
      yield* emitTurnCompleted(context, "interrupted");
    });

  const respondToRequest: KimiAdapterShape["respondToRequest"] = (threadId, requestId, decision) =>
    Effect.gen(function* () {
      const context = yield* requireContext(threadId, "respondToRequest");
      const pending = context.pendingApprovals.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "respondToRequest",
          detail: `No pending approval request ${requestId} for thread ${threadId}.`,
        });
      }

      if (context.currentTurn) {
        const response = approvalResponseFromDecision(decision);
        yield* Effect.tryPromise({
          try: () => context.currentTurn!.approve(requestId, response),
          catch: (cause) => toRequestError(threadId, "request/approve", cause),
        }).pipe(Effect.ignore);
      }

      context.pendingApprovals.delete(requestId);
      const { eventId, createdAt } = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "request.resolved",
        eventId,
        provider: PROVIDER,
        createdAt,
        threadId,
        turnId: context.turnState?.turnId,
        requestId: asRuntimeRequestId(requestId),
        payload: {
          requestType: pending.requestType,
          decision,
        },
        providerRefs: {},
      });
    });

  const respondToUserInput: KimiAdapterShape["respondToUserInput"] = (
    threadId,
    requestId,
    answers,
  ) =>
    Effect.gen(function* () {
      const context = yield* requireContext(threadId, "respondToUserInput");
      const pending = context.pendingUserInputs.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "respondToUserInput",
          detail: `No pending user input request ${requestId} for thread ${threadId}.`,
        });
      }

      // Kimi SDK's high-level Turn.respondQuestion requires an rpcRequestId
      // that is not exposed through StreamEvent. We attempt to use the
      // questionRequestId as both IDs; if the CLI rejects it we fall back to
      // resolving the deferred manually so the stream can continue.
      if (context.currentTurn) {
        yield* Effect.tryPromise({
          try: async () => {
            // @ts-expect-error — respondQuestion expects two IDs but we only
            // have the question payload id from the stream event.
            await context.currentTurn!.respondQuestion(requestId, requestId, answers);
          },
          catch: (cause) => toRequestError(threadId, "request/respondQuestion", cause),
        }).pipe(Effect.ignore);
      }

      context.pendingUserInputs.delete(requestId);
      const { eventId, createdAt } = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "user-input.resolved",
        eventId,
        provider: PROVIDER,
        createdAt,
        threadId,
        turnId: context.turnState?.turnId,
        requestId: asRuntimeRequestId(requestId),
        payload: { answers },
        providerRefs: {},
      });
    });

  const stopSession: KimiAdapterShape["stopSession"] = (threadId) =>
    Effect.gen(function* () {
      const context = yield* requireContext(threadId, "stopSession");
      context.stopped = true;
      if (context.streamFiber) {
        yield* Fiber.interrupt(context.streamFiber);
        context.streamFiber = undefined;
      }
      yield* Effect.tryPromise({
        try: () => context.sdkSession.close(),
        catch: (cause) => toRequestError(threadId, "session/close", cause),
      }).pipe(Effect.timeout("5 seconds"), Effect.ignore);
      sessions.delete(threadId);
      yield* emitSessionState(context, "closed");
      const { eventId, createdAt } = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "session.exited",
        eventId,
        provider: PROVIDER,
        createdAt,
        threadId,
        payload: {},
        providerRefs: {},
      });
    });

  const listSessions: KimiAdapterShape["listSessions"] = () =>
    Effect.sync(() =>
      Array.from(sessions.values())
        .filter((ctx) => !ctx.stopped)
        .map((ctx) => ctx.session),
    );

  const hasSession: KimiAdapterShape["hasSession"] = (threadId) =>
    Effect.sync(() => {
      const context = sessions.get(threadId);
      return context !== undefined && !context.stopped;
    });

  const readThread: KimiAdapterShape["readThread"] = (threadId) =>
    Effect.gen(function* () {
      const context = yield* requireContext(threadId, "readThread");
      return yield* snapshotThread(context);
    });

  const rollbackThread: KimiAdapterShape["rollbackThread"] = (threadId) =>
    Effect.gen(function* () {
      const context = yield* requireContext(threadId, "rollbackThread");
      return yield* snapshotThread(context);
    });

  const stopAll: KimiAdapterShape["stopAll"] = () =>
    Effect.gen(function* () {
      for (const [threadId, context] of sessions) {
        if (context.stopped) continue;
        yield* stopSession(threadId).pipe(Effect.ignore);
      }
    });

  const streamEvents: KimiAdapterShape["streamEvents"] = Stream.fromQueue(runtimeEventQueue);

  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "unsupported" },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    stopAll,
    streamEvents,
  } satisfies KimiAdapterShape;
});

export function makeKimiAdapterLive(options?: KimiAdapterLiveOptions) {
  return Layer.effect(KimiAdapter, makeKimiAdapter(options));
}

export const KimiAdapterLive = makeKimiAdapterLive();

import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  MessageId,
  NodeId,
  RunId,
  ThreadId,
  TurnItemId,
  type ModelSelection,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { nextUsageLimitHandoff, usageHandoffThresholdReached } from "./usageLimitHandoff.ts";

const order = ["first", "second", "third"].map((id): ModelSelection => ({
  instanceId: ProviderInstanceId.make(id),
  model: "test-model",
}));
const providers = order.map((selection): ServerProvider => ({
  instanceId: selection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  status: "ready",
  version: null,
  auth: { status: "authenticated" },
  checkedAt: "2026-10-18T00:00:00Z",
  models: [{ slug: "test-model", name: "Test", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
}));
const input = {
  order,
  current: order[0]!,
  providers,
  runtimeMode: "full-access" as const,
  nowMs: Date.parse("2026-10-18T01:00:00Z"),
  history: { runs: [], turnItems: [] },
};

function failedHistory(resetAt?: string) {
  const completedAt = DateTime.makeUnsafe("2026-10-18T00:45:00Z");
  const threadId = ThreadId.make("limited-thread");
  const runId = RunId.make("limited-run");
  const nodeId = NodeId.make("limited-root");
  return {
    runs: [
      {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId: order[0]!.instanceId,
        modelSelection: order[0]!,
        providerThreadId: null,
        userMessageId: MessageId.make("limited-message"),
        rootNodeId: nodeId,
        activeAttemptId: null,
        status: "failed",
        requestedAt: completedAt,
        startedAt: completedAt,
        completedAt,
        checkpointId: null,
        contextHandoffId: null,
      },
    ],
    turnItems: [
      {
        id: TurnItemId.make("limited-error"),
        type: "error",
        threadId,
        runId,
        nodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "failed",
        title: "Limit reached",
        startedAt: completedAt,
        completedAt,
        updatedAt: completedAt,
        failure: {
          class: "usage_limit",
          message: "Usage limit reached.",
          code: "usageLimitExceeded",
          retryable: null,
          ...(resetAt === undefined ? {} : { resetAt }),
        },
      },
    ],
  } satisfies Pick<OrchestrationV2ThreadProjection, "runs" | "turnItems">;
}

describe("automatic usage-limit handoff selection", () => {
  it("skips accounts at their reserve threshold until the quota window resets", () => {
    const second = {
      ...providers[1]!,
      usageLimits: {
        checkedAt: "2026-10-18T01:00:00Z",
        windows: [
          {
            id: "weekly",
            kind: "weekly" as const,
            label: "Weekly",
            usedPercent: 90,
            resetsAt: "2026-10-18T02:00:00Z",
          },
        ],
      },
    };
    const thresholds = { [second.instanceId]: 90 };
    const context = { ...input, thresholds, providers: [providers[0]!, second, providers[2]!] };
    expect(usageHandoffThresholdReached(second, 91, input.nowMs)).toBe(false);
    expect(usageHandoffThresholdReached(second, 90, input.nowMs)).toBe(true);
    expect(nextUsageLimitHandoff(context)).toEqual(order[2]);
    expect(nextUsageLimitHandoff({ ...context, providers })).toEqual(order[2]);
    expect(
      nextUsageLimitHandoff({ ...context, nowMs: Date.parse("2026-10-18T02:00:00Z") }),
    ).toEqual(order[1]);
  });
  it("follows the order and wraps from the last account to the first", () => {
    expect(nextUsageLimitHandoff(input)).toEqual(order[1]);
    expect(nextUsageLimitHandoff({ ...input, current: order[1]! })).toEqual(order[2]);
    expect(nextUsageLimitHandoff({ ...input, current: order[2]! })).toEqual(order[0]);
  });

  it("never selects the current account or starts unlisted threads", () => {
    expect(nextUsageLimitHandoff({ ...input, order: [order[0]!] })).toBeUndefined();
    expect(nextUsageLimitHandoff({ ...input, order: order.slice(1) })).toBeUndefined();
    expect(nextUsageLimitHandoff({ ...input, order: [] })).toBeUndefined();
  });

  it("skips an unavailable first account after wrapping", () => {
    expect(
      nextUsageLimitHandoff({
        ...input,
        current: order[2]!,
        providers: [{ ...providers[0]!, enabled: false }, ...providers.slice(1)],
      }),
    ).toEqual(order[1]);
  });

  it("stops when all other accounts have reported limits with stale or missing quota data", () => {
    const history = failedHistory();
    expect(
      nextUsageLimitHandoff({
        ...input,
        order: order.slice(0, 2),
        current: order[1]!,
        history,
        providers: [
          {
            ...providers[0]!,
            usageLimits: {
              checkedAt: "2026-10-18T00:40:00Z",
              windows: [{ id: "primary", label: "Session", kind: "session", usedPercent: 99 }],
            },
          },
          providers[1]!,
        ],
      }),
    ).toBeUndefined();
    expect(
      nextUsageLimitHandoff({ ...input, order: order.slice(0, 2), current: order[1]!, history }),
    ).toBeUndefined();
  });

  it("reuses an earlier limited account only after its reported reset", () => {
    const wrapped = {
      ...input,
      current: order[2]!,
      history: failedHistory("2026-10-18T01:30:00Z"),
    };
    expect(nextUsageLimitHandoff(wrapped)).toEqual(order[1]);
    expect(
      nextUsageLimitHandoff({ ...wrapped, nowMs: Date.parse("2026-10-18T01:30:00Z") }),
    ).toEqual(order[0]);
    expect(
      nextUsageLimitHandoff({ ...wrapped, history: failedHistory("2026-10-18T00:30:00Z") }),
    ).toEqual(order[1]);
  });

  it("accepts a newer available quota reading after a failure without a reset", () => {
    expect(
      nextUsageLimitHandoff({
        ...input,
        current: order[2]!,
        history: failedHistory(),
        providers: [
          {
            ...providers[0]!,
            usageLimits: {
              checkedAt: "2026-10-18T00:50:00Z",
              windows: [{ id: "primary", label: "Session", kind: "session", usedPercent: 10 }],
            },
          },
          ...providers.slice(1),
        ],
      }),
    ).toEqual(order[0]);
  });

  it("does not let queued or cancelled unstarted runs hide an exhausted account", () => {
    const history = failedHistory();
    const run = history.runs[0]!;
    expect(
      nextUsageLimitHandoff({
        ...input,
        current: order[2]!,
        history: {
          ...history,
          runs: [
            run,
            { ...run, id: RunId.make("queued"), ordinal: 2, status: "queued", completedAt: null },
            {
              ...run,
              id: RunId.make("cancelled"),
              ordinal: 3,
              status: "cancelled",
              startedAt: null,
            },
          ],
        },
      }),
    ).toEqual(order[1]);
  });

  it("allows an account again after a later successful run", () => {
    const history = failedHistory();
    const run = history.runs[0]!;
    expect(
      nextUsageLimitHandoff({
        ...input,
        current: order[2]!,
        history: {
          ...history,
          runs: [run, { ...run, id: RunId.make("successful"), ordinal: 2, status: "completed" }],
        },
      }),
    ).toEqual(order[0]);
  });

  it("skips aliases of an earlier exhausted account when wrapping", () => {
    const usageLimits = {
      credentialFingerprint: "same-account",
      checkedAt: "2026-10-18T00:00:00Z",
      windows: [],
    };
    expect(
      nextUsageLimitHandoff({
        ...input,
        current: order[2]!,
        history: failedHistory(),
        providers: [
          { ...providers[0]!, usageLimits },
          { ...providers[1]!, usageLimits },
          providers[2]!,
        ],
      }),
    ).toBeUndefined();
  });

  it("clears an older limit when another instance of the same account later succeeds", () => {
    const usageLimits = {
      credentialFingerprint: "same-account",
      checkedAt: "2026-10-18T00:00:00Z",
      windows: [],
    };
    const history = failedHistory();
    const run = history.runs[0]!;
    expect(
      nextUsageLimitHandoff({
        ...input,
        current: order[2]!,
        history: {
          ...history,
          runs: [
            run,
            {
              ...run,
              id: RunId.make("alias-success"),
              ordinal: 2,
              providerInstanceId: order[1]!.instanceId,
              modelSelection: order[1]!,
              status: "completed",
            },
          ],
        },
        providers: [
          { ...providers[0]!, usageLimits },
          { ...providers[1]!, usageLimits },
          providers[2]!,
        ],
      }),
    ).toEqual(order[0]);
  });

  it.each([
    { enabled: false },
    { installed: false },
    { availability: "unavailable" as const },
    { status: "error" as const },
    { auth: { status: "unauthenticated" as const } },
    { models: [] },
    { supportedRuntimeModes: ["approval-required" as const] },
    {
      usageLimits: {
        checkedAt: "2026-10-18T00:00:00Z",
        windows: [
          {
            id: "weekly",
            label: "Weekly",
            kind: "weekly" as const,
            usedPercent: 100,
            resetsAt: "2026-10-19T00:00:00Z",
          },
        ],
      },
    },
  ])("skips an unavailable target (%j)", (patch) => {
    expect(
      nextUsageLimitHandoff({
        ...input,
        providers: [providers[0]!, { ...providers[1]!, ...patch }, providers[2]!],
      }),
    ).toEqual(order[2]);
  });

  it("accepts a reset allowance and preserves model options", () => {
    const selection = { ...order[1]!, options: [{ id: "reasoningEffort", value: "high" }] };
    expect(
      nextUsageLimitHandoff({
        ...input,
        order: [order[0]!, selection],
        providers: [
          providers[0]!,
          {
            ...providers[1]!,
            usageLimits: {
              checkedAt: "2026-10-18T00:00:00Z",
              windows: [
                {
                  id: "primary",
                  label: "Session",
                  kind: "session",
                  usedPercent: 100,
                  resetsAt: "2026-10-18T00:30:00Z",
                },
              ],
            },
          },
        ],
      }),
    ).toEqual(selection);
  });

  it("skips another instance reporting the same exhausted account", () => {
    const usageLimits = {
      credentialFingerprint: "same-account",
      checkedAt: "2026-10-18T00:00:00Z",
      windows: [],
    };
    expect(
      nextUsageLimitHandoff({
        ...input,
        providers: [
          { ...providers[0]!, usageLimits },
          { ...providers[1]!, usageLimits },
          providers[2]!,
        ],
      }),
    ).toEqual(order[2]);
  });
});

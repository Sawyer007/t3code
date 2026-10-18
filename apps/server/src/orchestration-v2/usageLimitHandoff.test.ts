import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import { nextUsageLimitHandoff } from "./usageLimitHandoff.ts";

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
};

describe("automatic usage-limit handoff selection", () => {
  it("moves forward, never starts unlisted threads, and stops at the end", () => {
    expect(nextUsageLimitHandoff(input)).toEqual(order[1]);
    expect(nextUsageLimitHandoff({ ...input, current: order[2]! })).toBeUndefined();
    expect(nextUsageLimitHandoff({ ...input, order: [] })).toBeUndefined();
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

import {
  ProviderInstanceId,
  RunId,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
  type ModelSelection,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  resolveHandoffEndpoints,
  resolvePendingHandoff,
  type HandoffTimelineRun,
  editUsageLimitHandoffOrder,
  usageLimitHandoffOrderPatch,
} from "./handoff.ts";

describe("automatic handoff order editing shared by clients", () => {
  const order: ReadonlyArray<ModelSelection> = [
    {
      instanceId: ProviderInstanceId.make("codex"),
      model: "first",
      options: [{ id: "effort", value: "high" }],
    },
    { instanceId: ProviderInstanceId.make("claudeAgent"), model: "second" },
  ];
  it("preserves account model options while reordering without changing the saved list", () => {
    const moved = editUsageLimitHandoffOrder(order, { type: "move", index: 1, offset: -1 });
    expect(moved).toEqual([order[1], order[0]]);
    expect(order[0]?.model).toBe("first");
    expect(editUsageLimitHandoffOrder(order, { type: "move", index: 0, offset: -1 })).toBe(order);
    expect(editUsageLimitHandoffOrder(order, { type: "move", index: 1, offset: 1 })).toBe(order);
  });
  it("prevents duplicate accounts and limits the list to sixteen entries", () => {
    expect(
      editUsageLimitHandoffOrder(order, {
        type: "select",
        index: 1,
        selection: { ...order[0]!, model: "another-model" },
      }),
    ).toBe(order);
    const full = Array.from({ length: 16 }, (_, index) => ({
      instanceId: ProviderInstanceId.make(`account${index}`),
      model: "model",
    }));
    expect(
      editUsageLimitHandoffOrder(full, { type: "select", index: 16, selection: order[0]! }),
    ).toBe(full);
  });
  it("can append a new account and disables handoff if fewer than two remain", () => {
    expect(
      editUsageLimitHandoffOrder(order.slice(0, 1), {
        type: "select",
        index: 1,
        selection: order[1]!,
      }),
    ).toEqual(order);
    const reduced = editUsageLimitHandoffOrder(order, { type: "remove", index: 1 });
    expect(usageLimitHandoffOrderPatch(reduced)).toEqual({
      usageLimitHandoffOrder: [order[0]],
      autoHandoffLimitedThreads: false,
    });
    expect(usageLimitHandoffOrderPatch(order)).toEqual({ usageLimitHandoffOrder: order });
  });
});

const from = ProviderInstanceId.make("codex_personal");
const to = ProviderInstanceId.make("claudeAgent");
const item = {
  runId: RunId.make("target"),
  fromProviderInstanceIds: [from],
  toProviderInstanceId: to,
};
const run = (
  id: string,
  ordinal: number,
  instanceId: ProviderInstanceId,
  model: string,
): HandoffTimelineRun => ({
  id: RunId.make(id),
  ordinal,
  providerInstanceId: instanceId,
  modelSelection: { instanceId, model },
});

describe("handoff endpoints shared by web and mobile", () => {
  it("preserves stamped models including several models from the same provider", () => {
    const fromModelSelections = [
      { instanceId: from, model: "source-a" },
      { instanceId: from, model: "source-b" },
    ];
    expect(
      resolveHandoffEndpoints({ ...item, fromModelSelections, toModel: "destination" }, [
        run("target", 2, to, "later-model"),
      ]),
    ).toEqual({
      from: fromModelSelections,
      to: { instanceId: to, model: "destination" },
    });
  });

  it("recovers legacy models from the handoff run and latest earlier source run", () => {
    const runs = [
      run("later", 4, from, "wrong-later-model"),
      run("old", 1, from, "old-model"),
      run("target", 3, to, "destination"),
      run("source", 2, from, "source-model"),
    ];
    expect(resolveHandoffEndpoints(item, runs)).toEqual({
      from: [{ instanceId: from, model: "source-model" }],
      to: { instanceId: to, model: "destination" },
    });
  });

  it("retains provider identities when historical runs are not loaded", () => {
    expect(resolveHandoffEndpoints(item, [])).toEqual({
      from: [{ instanceId: from, model: undefined }],
      to: { instanceId: to, model: undefined },
    });
  });

  it("does not borrow a target model from another provider", () => {
    expect(
      resolveHandoffEndpoints(item, [run("target", 2, from, "wrong-model")]).to.model,
    ).toBeUndefined();
  });
});

const projection = {
  runs: [{ ...run("source", 1, from, "source"), startedAt: "2026-10-11T00:00:00Z" }],
  visibleTurnItems: [{ item: { type: "user_message" } }],
} as unknown as OrchestrationV2ThreadProjection;

describe("pending context handoff", () => {
  it("appears on selection, updates the destination, and disappears on returning", () => {
    expect(resolvePendingHandoff(projection, { instanceId: to, model: "first" }, [])).toEqual({
      from: [{ instanceId: from, model: "source" }],
      to: { instanceId: to, model: "first" },
    });
    expect(
      resolvePendingHandoff(projection, { instanceId: to, model: "second" }, [])?.to.model,
    ).toBe("second");
    expect(resolvePendingHandoff(projection, { instanceId: from, model: "source" }, [])).toBeNull();
    expect(resolvePendingHandoff(projection, { instanceId: from, model: "other" }, [])).toBeNull();
  });
  it("stays hidden while the thread's timeline is empty", () => {
    const empty = { ...projection, visibleTurnItems: [] };
    expect(resolvePendingHandoff(empty, { instanceId: to, model: "first" }, [])).toBeNull();
    // Paging can leave a window of only tool rows after the prompt.
    const toolRowsOnly = {
      ...projection,
      visibleTurnItems: [{ item: { type: "command_execution" } }],
    } as unknown as OrchestrationV2ThreadProjection;
    expect(
      resolvePendingHandoff(toolRowsOnly, { instanceId: to, model: "first" }, [])?.to.model,
    ).toBe("first");
  });
  it("only previews a same-provider model change when it needs a fresh native thread", () => {
    const providers = [
      { instanceId: from, requiresNewThreadForModelChange: true },
    ] as unknown as ServerProvider[];
    expect(
      resolvePendingHandoff(projection, { instanceId: from, model: "other" }, providers)?.to.model,
    ).toBe("other");
  });
  it("resumes compatible account overlays without showing a handoff", () => {
    const providers = [from, to].map((instanceId) => ({
      instanceId,
      driver: "codex",
      continuation: { groupKey: "shared" },
    })) as unknown as ServerProvider[];
    expect(
      resolvePendingHandoff(projection, { instanceId: to, model: "target" }, providers),
    ).toBeNull();
  });
});

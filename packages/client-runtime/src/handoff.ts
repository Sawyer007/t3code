import type {
  ModelSelection,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  ProviderInstanceId,
  ServerProvider,
  ServerSettingsPatch,
} from "@t3tools/contracts";

export function editUsageLimitHandoffOrder(
  order: ReadonlyArray<ModelSelection>,
  action:
    | { readonly type: "select"; readonly index: number; readonly selection: ModelSelection }
    | { readonly type: "move"; readonly index: number; readonly offset: -1 | 1 }
    | { readonly type: "remove"; readonly index: number },
): ReadonlyArray<ModelSelection> {
  if (action.index < 0 || action.index > order.length) return order;
  if (action.type === "select") {
    if (
      action.index >= 16 ||
      order.some(
        (entry, index) =>
          index !== action.index && entry.instanceId === action.selection.instanceId,
      )
    )
      return order;
    const next = [...order];
    next[action.index] = action.selection;
    return next;
  }
  if (action.index >= order.length) return order;
  if (action.type === "remove") return order.filter((_, index) => index !== action.index);
  const destination = action.index + action.offset;
  if (destination < 0 || destination >= order.length) return order;
  const next = [...order];
  [next[action.index], next[destination]] = [next[destination]!, next[action.index]!];
  return next;
}

export function usageLimitHandoffOrderPatch(
  order: ReadonlyArray<ModelSelection>,
): ServerSettingsPatch {
  return {
    usageLimitHandoffOrder: order,
    ...(order.length < 2 ? { autoHandoffLimitedThreads: false } : {}),
  };
}

export type HandoffTimelineRun = Pick<
  OrchestrationV2Run,
  "id" | "ordinal" | "providerInstanceId" | "modelSelection"
>;

export type HandoffEndpoints = ReturnType<typeof resolveHandoffEndpoints>;

export function resolvePendingHandoff(
  projection: OrchestrationV2ThreadProjection | null | undefined,
  selection: ModelSelection | null | undefined,
  providers: ReadonlyArray<ServerProvider>,
): HandoffEndpoints | null {
  // A thread with an empty timeline has nothing to hand off. Any loaded row
  // counts: paging can leave a window of only tool rows.
  if (!projection?.visibleTurnItems.length) return null;
  const from = projection.runs.findLast(
    (run) => run.startedAt !== null && run.status !== "rolled_back",
  )?.modelSelection;
  if (from === undefined || selection == null) return null;
  const source = providers.find((provider) => provider.instanceId === from.instanceId);
  const target = providers.find((provider) => provider.instanceId === selection.instanceId);
  const needsHandoff =
    from.instanceId === selection.instanceId
      ? from.model !== selection.model && target?.requiresNewThreadForModelChange === true
      : source?.continuation?.groupKey === undefined ||
        source.driver !== target?.driver ||
        source.continuation.groupKey !== target.continuation?.groupKey;
  return needsHandoff ? { from: [from], to: selection } : null;
}

export function resolveHandoffEndpoints(
  item: Pick<
    Extract<OrchestrationV2TurnItem, { type: "handoff" }>,
    "runId" | "fromModelSelections" | "fromProviderInstanceIds" | "toModel" | "toProviderInstanceId"
  >,
  runs: ReadonlyArray<HandoffTimelineRun>,
) {
  const handoffRun = item.runId === null ? undefined : runs.find((run) => run.id === item.runId);
  const toModel =
    item.toModel ??
    (handoffRun !== undefined && handoffRun.providerInstanceId === item.toProviderInstanceId
      ? handoffRun.modelSelection.model
      : undefined);
  const fromEndpoints: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly model?: string | undefined;
  }> =
    item.fromModelSelections !== undefined && item.fromModelSelections.length > 0
      ? item.fromModelSelections
      : item.fromProviderInstanceIds.map((instanceId) => ({
          instanceId,
          model: latestRunModelBefore(runs, instanceId, handoffRun?.ordinal),
        }));
  return { from: fromEndpoints, to: { instanceId: item.toProviderInstanceId, model: toModel } };
}

function latestRunModelBefore(
  runs: ReadonlyArray<HandoffTimelineRun>,
  instanceId: ProviderInstanceId,
  beforeOrdinal: number | undefined,
): string | undefined {
  let latest: HandoffTimelineRun | undefined;
  for (const run of runs) {
    if (run.providerInstanceId !== instanceId) continue;
    if (beforeOrdinal !== undefined && run.ordinal >= beforeOrdinal) continue;
    if (latest === undefined || run.ordinal > latest.ordinal) latest = run;
  }
  return latest?.modelSelection.model;
}

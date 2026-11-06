import type {
  ModelSelection,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  RuntimeMode,
  ServerProvider,
  UsageLimitHandoffThresholds,
} from "@t3tools/contracts";
import { latestRootProviderFailure, runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";

function currentUsagePercent(
  provider: ServerProvider | undefined,
  nowMs: number,
): number | undefined {
  const limits = provider?.usageLimits;
  if (!limits || limits.unavailable || limits.windows.length === 0) return undefined;
  return Math.max(
    ...limits.windows.map((window) =>
      window.resetsAt !== undefined && Date.parse(window.resetsAt) <= nowMs
        ? 0
        : window.usedPercent,
    ),
  );
}

export function usageHandoffThresholdReached(
  provider: ServerProvider | undefined,
  threshold: number | undefined,
  nowMs: number,
): boolean {
  return typeof threshold === "number" && (currentUsagePercent(provider, nowMs) ?? -1) >= threshold;
}

export function nextUsageLimitHandoff(input: {
  readonly order: ReadonlyArray<ModelSelection>;
  readonly current: ModelSelection;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly thresholds?: UsageLimitHandoffThresholds;
  readonly runtimeMode: RuntimeMode;
  readonly nowMs: number;
  readonly history: Pick<OrchestrationV2ThreadProjection, "runs" | "turnItems">;
}) {
  const index = input.order.findIndex(
    (selection) => selection.instanceId === input.current.instanceId,
  );
  if (index < 0) return undefined;
  const providers = new Map(input.providers.map((provider) => [provider.instanceId, provider]));
  const source = providers.get(input.current.instanceId);
  const accountKey = (instanceId: ModelSelection["instanceId"]) => {
    const fingerprint = providers.get(instanceId)?.usageLimits?.credentialFingerprint;
    return fingerprint ? `account:${fingerprint}` : `instance:${instanceId}`;
  };
  const latestRuns = new Map<string, OrchestrationV2Run>();
  for (const run of input.history.runs) {
    if (run.status === "queued" || (run.status === "cancelled" && run.startedAt === null)) continue;
    const key = accountKey(run.providerInstanceId);
    const previous = latestRuns.get(key);
    if (previous === undefined || runRanAfter(run, previous)) latestRuns.set(key, run);
  }
  const previouslyLimited = (provider: ServerProvider) => {
    const run = latestRuns.get(accountKey(provider.instanceId));
    const failure = latestRootProviderFailure(run ?? null, input.history.turnItems);
    if (!run || failure?.class !== "usage_limit") return false;
    const reportedAt = DateTime.toEpochMillis(run.completedAt ?? run.requestedAt);
    const resetMs = Date.parse(failure.resetAt ?? "");
    if (resetMs > reportedAt && resetMs <= input.nowMs) return false;
    // Limit snapshots can lag a terminal failure (including reports without resetAt).
    // Only a newer allowance reading or the reported reset makes that account eligible again.
    const limits = provider.usageLimits;
    return !(limits && limits.windows.length > 0 && Date.parse(limits.checkedAt) > reportedAt);
  };
  return [...input.order.slice(index + 1), ...input.order.slice(0, index)].find((selection) => {
    const provider = providers.get(selection.instanceId);
    const threshold = input.thresholds?.[selection.instanceId];
    return (
      provider !== undefined &&
      provider.enabled &&
      provider.installed &&
      provider.availability !== "unavailable" &&
      (provider.status === "ready" || provider.status === "warning") &&
      provider.auth.status !== "unauthenticated" &&
      (provider.supportedRuntimeModes === undefined ||
        provider.supportedRuntimeModes.includes(input.runtimeMode)) &&
      provider.models.some(
        (model) => model.slug === selection.model || model.aliases?.includes(selection.model),
      ) &&
      !(
        source?.usageLimits?.credentialFingerprint &&
        source.usageLimits.credentialFingerprint === provider.usageLimits?.credentialFingerprint
      ) &&
      !provider.usageLimits?.windows.some(
        (window) =>
          window.usedPercent >= 100 &&
          (!window.resetsAt || !(Date.parse(window.resetsAt) <= input.nowMs)),
      ) &&
      (typeof threshold !== "number" ||
        (currentUsagePercent(provider, input.nowMs) ?? Infinity) < threshold) &&
      !previouslyLimited(provider)
    );
  });
}

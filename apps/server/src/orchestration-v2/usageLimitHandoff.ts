import type { ModelSelection, RuntimeMode, ServerProvider } from "@t3tools/contracts";

export function nextUsageLimitHandoff(input: {
  readonly order: ReadonlyArray<ModelSelection>;
  readonly current: ModelSelection;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly runtimeMode: RuntimeMode;
  readonly nowMs: number;
}) {
  const index = input.order.findIndex(
    (selection) => selection.instanceId === input.current.instanceId,
  );
  if (index < 0) return undefined;
  const source = input.providers.find(
    (provider) => provider.instanceId === input.current.instanceId,
  );
  // Only move forward. Retrying earlier accounts without a new limit report can loop forever.
  return input.order.slice(index + 1).find((selection) => {
    const provider = input.providers.find(
      (candidate) => candidate.instanceId === selection.instanceId,
    );
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
      )
    );
  });
}

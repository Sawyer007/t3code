import { useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from "lucide-react";
import type {
  EnvironmentId,
  ModelSelection,
  ServerSettingsPatch,
  UnifiedSettings,
} from "@t3tools/contracts";
import {
  editUsageLimitHandoffOrder,
  usageLimitHandoffOrderPatch,
} from "@t3tools/client-runtime/handoff";
import * as Equal from "effect/Equal";
import { createModelSelection } from "@t3tools/shared/model";

import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { useEnvironmentProviders } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import type { ModelEsque } from "../chat/providerIconUtils";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettings, useScopedSettingsWriteAllowed } from "./useScopedSettings";
import { searchableSetting } from "./settingsSearch";
import { SettingsRow, SETTINGS_PICKER_TRIGGER_CLASSNAME } from "./settingsLayout";

export function AutoHandoffSettings() {
  const settings = useScopedSettings();
  const { scope, connectedEnvironments, environment } = useSettingsScope();
  const providersByEnvironment = useEnvironmentProviders();
  const canWrite = useScopedSettingsWriteAllowed();
  const update = useAtomCommand(serverEnvironment.updateSettings);
  const [pending, setPending] = useState(false);
  const singleEnvironment =
    scope.environmentIds.length === 1 &&
    connectedEnvironments.length === 1 &&
    (scope.kind === "environment" || scope.kind === "all");
  const environmentId = singleEnvironment ? (environment?.environmentId ?? null) : null;
  const providers =
    (environmentId ? providersByEnvironment.get(environmentId) : undefined) ??
    EMPTY_SERVER_PROVIDERS;
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings, null),
  );
  const models = getCustomModelOptionsByInstance(settings, providers);
  const supported =
    environment?.serverConfig?.environment.capabilities.automaticProviderHandoff === true;
  const disabled = !canWrite || !environmentId || !supported || pending;
  const save = (patch: ServerSettingsPatch) => {
    if (disabled || !environmentId) return;
    setPending(true);
    void update({ environmentId, input: { patch } }).then(() => setPending(false));
  };

  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("auto-handoff-limited-threads")}
      settingKeys={["autoHandoffLimitedThreads", "usageLimitHandoffOrder"]}
      description={
        singleEnvironment
          ? supported
            ? "Continue with the next provider when a usage limit is reached. Switching this off keeps your saved order."
            : "Update this environment to a version supporting automatic provider handoff."
          : "Select one environment to configure its automatic provider handoff."
      }
      control={
        <Switch
          aria-label="Automatic provider handoff"
          checked={singleEnvironment && settings.autoHandoffLimitedThreads}
          disabled={
            disabled ||
            (!settings.autoHandoffLimitedThreads && settings.usageLimitHandoffOrder.length < 2)
          }
          onCheckedChange={(checked) => save({ autoHandoffLimitedThreads: checked })}
        />
      }
    >
      {environmentId && supported ? (
        <HandoffOrderEditor
          key={`${environmentId}:${JSON.stringify(settings.usageLimitHandoffOrder)}`}
          environmentId={environmentId}
          settings={settings}
          entries={entries}
          models={models}
          disabled={disabled}
          onSave={save}
        />
      ) : null}
    </SettingsRow>
  );
}

function HandoffOrderEditor(props: {
  readonly environmentId: EnvironmentId;
  readonly settings: UnifiedSettings;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly models: ReadonlyMap<ModelSelection["instanceId"], ReadonlyArray<ModelEsque>>;
  readonly disabled: boolean;
  readonly onSave: (patch: ServerSettingsPatch) => void;
}) {
  const saved = props.settings.usageLimitHandoffOrder;
  const [draft, setDraft] = useState(saved);
  const dirty = !Equal.equals(saved, draft);
  const nextEntry = props.entries.find(
    (entry) =>
      entry.enabled &&
      entry.isAvailable &&
      !draft.some((selection) => selection.instanceId === entry.instanceId) &&
      props.models.get(entry.instanceId)?.some((model) => !model.isUnavailable),
  );
  const nextModel = nextEntry
    ? (props.models
        .get(nextEntry.instanceId)
        ?.find((model) => !model.isUnavailable && model.isDefault) ??
      props.models.get(nextEntry.instanceId)?.find((model) => !model.isUnavailable))
    : undefined;

  return (
    <div className="space-y-3 py-3">
      <p className="text-xs text-muted-foreground">
        Add and save at least two provider accounts to enable handoff. It moves forward through this
        order; accounts can share quota.
      </p>
      <ol className="space-y-2">
        {draft.map((selection, index) => {
          const entry = props.entries.find((entry) => entry.instanceId === selection.instanceId);
          return (
            <li key={selection.instanceId} className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 text-sm">
                {index + 1}. {entry?.displayName ?? selection.instanceId}
              </span>
              <ProviderModelPicker
                environmentId={props.environmentId}
                activeInstanceId={selection.instanceId}
                model={selection.model}
                lockedProvider={null}
                instanceEntries={props.entries}
                modelOptionsByInstance={props.models}
                disabled={props.disabled}
                triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                triggerAriaLabel={`Handoff provider and model ${index + 1}`}
                triggerLabel={
                  entry?.models.find((model) => model.slug === selection.model)?.name ??
                  selection.model
                }
                getModelDisabledReason={(instanceId, model) => {
                  if (draft.some((entry, row) => row !== index && entry.instanceId === instanceId))
                    return "This provider account is already in the order.";
                  const entry = props.entries.find(
                    (candidate) => candidate.instanceId === instanceId,
                  );
                  return entry?.enabled &&
                    entry.isAvailable &&
                    props.models
                      .get(instanceId)
                      ?.some((option) => option.slug === model && !option.isUnavailable)
                    ? null
                    : "This model is unavailable.";
                }}
                onInstanceModelChange={(instanceId, model) => {
                  if (instanceId === selection.instanceId && model === selection.model) return;
                  setDraft((current) =>
                    editUsageLimitHandoffOrder(current, {
                      type: "select",
                      index,
                      selection: { instanceId, model },
                    }),
                  );
                }}
              />
              {entry ? (
                <TraitsPicker
                  provider={entry.driverKind}
                  instanceId={selection.instanceId}
                  models={entry.models}
                  model={selection.model}
                  prompt=""
                  onPromptChange={() => {}}
                  modelOptions={selection.options}
                  allowPromptInjectedEffort={false}
                  planModeEnabled={props.settings.planModeEnabled}
                  disabled={props.disabled}
                  triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                  onModelOptionsChange={(options) =>
                    setDraft((current) =>
                      editUsageLimitHandoffOrder(current, {
                        type: "select",
                        index,
                        selection: createModelSelection(
                          selection.instanceId,
                          selection.model,
                          options,
                        ),
                      }),
                    )
                  }
                />
              ) : null}
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Move handoff provider ${index + 1} up`}
                  disabled={props.disabled || index === 0}
                  onClick={() =>
                    setDraft((current) =>
                      editUsageLimitHandoffOrder(current, { type: "move", index, offset: -1 }),
                    )
                  }
                >
                  <ArrowUpIcon />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Move handoff provider ${index + 1} down`}
                  disabled={props.disabled || index === draft.length - 1}
                  onClick={() =>
                    setDraft((current) =>
                      editUsageLimitHandoffOrder(current, { type: "move", index, offset: 1 }),
                    )
                  }
                >
                  <ArrowDownIcon />
                </Button>
                <Button
                  variant="ghost-destructive"
                  size="icon-xs"
                  aria-label={`Remove handoff provider ${index + 1}`}
                  disabled={props.disabled}
                  onClick={() =>
                    setDraft((current) =>
                      editUsageLimitHandoffOrder(current, { type: "remove", index }),
                    )
                  }
                >
                  <Trash2Icon />
                </Button>
              </div>
            </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={props.disabled || !nextEntry || !nextModel || draft.length >= 16}
          onClick={() => {
            if (nextEntry && nextModel)
              setDraft((current) =>
                editUsageLimitHandoffOrder(current, {
                  type: "select",
                  index: current.length,
                  selection: { instanceId: nextEntry.instanceId, model: nextModel.slug },
                }),
              );
          }}
        >
          <PlusIcon />
          Add provider
        </Button>
        <Button
          size="sm"
          disabled={props.disabled || !dirty}
          onClick={() => props.onSave(usageLimitHandoffOrderPatch(draft))}
        >
          Save order
        </Button>
        {dirty ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={props.disabled}
            onClick={() => setDraft(saved)}
          >
            Cancel
          </Button>
        ) : null}
      </div>
    </div>
  );
}

import { useState } from "react";
import { View } from "react-native";
import type { ModelSelection, ServerConfig, ServerSettingsPatch } from "@t3tools/contracts";
import { AuthSettingsWriteScope } from "@t3tools/contracts";
import {
  editUsageLimitHandoffOrder,
  usageLimitHandoffOrderPatch,
} from "@t3tools/client-runtime/handoff";
import * as Equal from "effect/Equal";
import {
  createModelSelection,
  getProviderOptionCurrentLabel,
  getProviderOptionCurrentValue,
} from "@t3tools/shared/model";

import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { IconButton } from "../../../components/ui/IconButton";
import { Menu } from "../../../components/ui/Menu";
import { buildModelOptions, groupByProvider, type ModelOption } from "../../../lib/modelOptions";
import {
  applyProviderOptionSelection,
  resolveProviderOptionDescriptors,
} from "../../../lib/providerOptions";
import { useEnvironmentServerConfig } from "../../../state/entities";
import { readEnvironmentScope, useEnvironmentsWithScope } from "../../../state/session";
import { serverEnvironment } from "../../../state/server";
import { useAtomCommand } from "../../../state/use-atom-command";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "../settings-environment-filter";
import { SettingsSection } from "./SettingsSection";
import { SettingsSwitchRow } from "./SettingsSwitchRow";

export function AutoHandoffSettingsSection() {
  const { selectedTargets, selectedProjectKey } = useSettingsEnvironmentFilter();
  if (selectedProjectKey !== null) return null;
  const target = selectedTargets.length === 1 ? selectedTargets[0] : undefined;
  return (
    <SettingsSection title="Automatic provider handoff">
      {target ? (
        <EnvironmentHandoffSettings target={target} />
      ) : (
        <Text className="p-4 text-sm text-foreground-muted">
          Select one environment to configure its provider handoff.
        </Text>
      )}
    </SettingsSection>
  );
}

function EnvironmentHandoffSettings({ target }: { readonly target: SettingsTarget }) {
  const config = useEnvironmentServerConfig(target.environmentId);
  const writable = useEnvironmentsWithScope([target], AuthSettingsWriteScope);
  const update = useAtomCommand(serverEnvironment.updateSettings);
  const [pending, setPending] = useState(false);
  if (!config)
    return <Text className="p-4 text-sm text-foreground-muted">Loading provider catalog…</Text>;
  const settings = config.settings;
  const supported = config.environment.capabilities.automaticProviderHandoff === true;
  const disabled = pending || !supported || !writable.has(target.environmentId);
  const save = (patch: ServerSettingsPatch) => {
    if (disabled || !readEnvironmentScope(target.environmentId, AuthSettingsWriteScope)) return;
    setPending(true);
    void update({ environmentId: target.environmentId, input: { patch } }).then(() =>
      setPending(false),
    );
  };
  return (
    <>
      <SettingsSwitchRow
        icon="arrow.triangle.branch"
        label="Automatic provider handoff"
        subtitle={
          supported
            ? "Continue with the next provider at a usage limit. Switching off keeps the saved order."
            : "Update this environment to a version supporting automatic provider handoff."
        }
        value={settings.autoHandoffLimitedThreads}
        disabled={
          disabled ||
          (!settings.autoHandoffLimitedThreads && settings.usageLimitHandoffOrder.length < 2)
        }
        onValueChange={(value) => save({ autoHandoffLimitedThreads: value })}
      />
      {supported ? (
        <HandoffOrderEditor
          key={`${target.environmentId}:${JSON.stringify(settings.usageLimitHandoffOrder)}`}
          config={config}
          disabled={disabled}
          onSave={save}
        />
      ) : null}
    </>
  );
}

function HandoffOrderEditor(props: {
  readonly config: ServerConfig;
  readonly disabled: boolean;
  readonly onSave: (patch: ServerSettingsPatch) => void;
}) {
  const saved = props.config.settings.usageLimitHandoffOrder;
  const [draft, setDraft] = useState(saved);
  const dirty = !Equal.equals(saved, draft);
  const models = buildModelOptions(props.config, null, undefined, null).filter(
    (model) => !model.isUnavailable && !model.isHidden,
  );
  const unusedModels = models.filter(
    (model) => !draft.some((selection) => selection.instanceId === model.selection.instanceId),
  );
  const next = unusedModels.find((model) => model.isDefault) ?? unusedModels[0];
  return (
    <View className="gap-3 p-4">
      <Text className="text-sm text-foreground-muted">
        Add and save at least two provider accounts to enable handoff. It moves forward through this
        order; accounts can share quota.
      </Text>
      {draft.map((selection, index) => (
        <View key={selection.instanceId} className="gap-2">
          <ModelMenu
            selection={selection}
            index={index}
            models={models.filter(
              (model) =>
                !draft.some(
                  (entry, row) => row !== index && entry.instanceId === model.selection.instanceId,
                ),
            )}
            label={`${index + 1}. ${models.find((model) => model.selection.instanceId === selection.instanceId && model.selection.model === selection.model)?.providerLabel ?? selection.instanceId} · ${models.find((model) => model.selection.instanceId === selection.instanceId && model.selection.model === selection.model)?.label ?? selection.model}`}
            disabled={props.disabled}
            onSelect={(nextSelection) => {
              if (
                nextSelection.instanceId === selection.instanceId &&
                nextSelection.model === selection.model
              )
                return;
              setDraft((current) =>
                editUsageLimitHandoffOrder(current, {
                  type: "select",
                  index,
                  selection: nextSelection,
                }),
              );
            }}
          />
          <ModelOptionsMenu
            selection={selection}
            model={models.find(
              (model) =>
                model.selection.instanceId === selection.instanceId &&
                model.selection.model === selection.model,
            )}
            disabled={props.disabled}
            onSelect={(nextSelection) =>
              setDraft((current) =>
                editUsageLimitHandoffOrder(current, {
                  type: "select",
                  index,
                  selection: nextSelection,
                }),
              )
            }
          />
          <View className="flex-row items-center gap-1">
            <IconButton
              icon="arrow.up"
              accessibilityLabel={`Move handoff provider ${index + 1} up`}
              disabled={props.disabled || index === 0}
              onPress={() =>
                setDraft((current) =>
                  editUsageLimitHandoffOrder(current, { type: "move", index, offset: -1 }),
                )
              }
            />
            <IconButton
              icon="arrow.down"
              accessibilityLabel={`Move handoff provider ${index + 1} down`}
              disabled={props.disabled || index === draft.length - 1}
              onPress={() =>
                setDraft((current) =>
                  editUsageLimitHandoffOrder(current, { type: "move", index, offset: 1 }),
                )
              }
            />
            <IconButton
              icon="trash"
              accessibilityLabel={`Remove handoff provider ${index + 1}`}
              disabled={props.disabled}
              onPress={() =>
                setDraft((current) =>
                  editUsageLimitHandoffOrder(current, { type: "remove", index }),
                )
              }
            />
          </View>
        </View>
      ))}
      <Button
        label="Add provider"
        icon="plus"
        disabled={props.disabled || !next || draft.length >= 16}
        onPress={() => {
          if (next)
            setDraft((current) =>
              editUsageLimitHandoffOrder(current, {
                type: "select",
                index: current.length,
                selection: next.selection,
              }),
            );
        }}
      />
      <Button
        label="Save order"
        tone="primary"
        disabled={props.disabled || !dirty}
        onPress={() => props.onSave(usageLimitHandoffOrderPatch(draft))}
      />
      {dirty ? (
        <Button
          label="Cancel"
          tone="text"
          disabled={props.disabled}
          onPress={() => setDraft(saved)}
        />
      ) : null}
    </View>
  );
}

function ModelOptionsMenu(props: {
  readonly selection: ModelSelection;
  readonly model: ModelOption | undefined;
  readonly disabled: boolean;
  readonly onSelect: (selection: ModelSelection) => void;
}) {
  const descriptors = resolveProviderOptionDescriptors({
    capabilities: props.model?.capabilities,
    selections: props.selection.options,
  });
  const options = descriptors.flatMap((descriptor) => {
    const choices =
      descriptor.type === "boolean"
        ? [
            { id: "true", label: "On", value: true },
            { id: "false", label: "Off", value: false },
          ]
        : descriptor.options
            .filter((option) => !descriptor.promptInjectedValues?.includes(option.id))
            .map((option) => ({ ...option, value: option.id }));
    return choices.length > 0 ? [{ descriptor, choices }] : [];
  });
  if (options.length === 0) return null;
  const label = options
    .map(
      ({ descriptor }) =>
        `${descriptor.label}: ${getProviderOptionCurrentLabel(descriptor, props.selection) ?? "Default"}`,
    )
    .join(" · ");
  const button = <Button label={label} disabled={props.disabled} onPress={() => {}} />;
  if (props.disabled) return button;
  return (
    <Menu
      title="Handoff model options"
      actions={options.map(({ descriptor, choices }) => ({
        id: descriptor.id,
        title: descriptor.label,
        subactions: choices.map((choice) => ({
          id: JSON.stringify([descriptor.id, choice.value]),
          title: choice.label,
          state:
            getProviderOptionCurrentValue(descriptor, props.selection) === choice.value
              ? ("on" as const)
              : ("off" as const),
        })),
      }))}
      onPressAction={({ nativeEvent }) => {
        for (const { descriptor, choices } of options) {
          const choice = choices.find(
            (choice) => JSON.stringify([descriptor.id, choice.value]) === nativeEvent.event,
          );
          if (!choice) continue;
          const selections = applyProviderOptionSelection(descriptors, {
            id: descriptor.id,
            value: choice.value,
          });
          if (selections)
            props.onSelect(
              createModelSelection(props.selection.instanceId, props.selection.model, selections),
            );
          return;
        }
      }}
    >
      {button}
    </Menu>
  );
}

function ModelMenu(props: {
  readonly selection: ModelSelection;
  readonly index: number;
  readonly models: ReadonlyArray<ModelOption>;
  readonly label: string;
  readonly disabled: boolean;
  readonly onSelect: (selection: ModelSelection) => void;
}) {
  const disabled = props.disabled || props.models.length === 0;
  const button = <Button label={props.label} disabled={disabled} onPress={() => {}} />;
  if (disabled) return button;
  return (
    <Menu
      title={`Handoff provider and model ${props.index + 1}`}
      actions={groupByProvider(props.models).map((group) => ({
        id: group.providerKey,
        title: group.providerLabel,
        subactions: group.models.map((model) => ({
          id: model.key,
          title: model.label,
          state:
            model.selection.instanceId === props.selection.instanceId &&
            model.selection.model === props.selection.model
              ? ("on" as const)
              : ("off" as const),
        })),
      }))}
      onPressAction={({ nativeEvent }) => {
        const model = props.models.find((candidate) => candidate.key === nativeEvent.event);
        if (model) props.onSelect(model.selection);
      }}
    >
      {button}
    </Menu>
  );
}

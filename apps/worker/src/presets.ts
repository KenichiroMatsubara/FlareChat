import membershipOrganization from '../presets/membership-organization.json';
import { eq } from 'drizzle-orm';

import type { OrganizationDatabase } from './storage/database';
import {
  agentRulePermittedLineLists,
  agentRulePermittedRecipientLists,
  agentRuleRevisions,
  agentRules,
  listItems,
  lists,
  operationalTaskRoles,
  promptRevisions,
  prompts,
  rulePermittedLineLists,
  rulePermittedRecipientLists,
  ruleRevisions,
  rules,
  settings,
} from './storage/organization-schema';

export interface PresetDocument {
  id: string;
  name: string;
  description: string;
  typedLists: Array<{
    key: string;
    kind: 'source' | 'recipient' | 'line';
    name: string;
    description: string;
    items: Array<{ value: string; label: string }>;
  }>;
  operationalTaskRoles: Array<{
    key: string;
    displayName: string;
    description: string;
  }>;
  prompts: Array<{
    key: string;
    name: string;
    instructions: string;
  }>;
  schemaRules: Array<{
    key: string;
    name: string;
    state: 'draft' | 'active' | 'suspended' | 'archived';
    sourceListKey: string;
    selectionPolicy: Record<string, unknown>;
    routingPolicy: Record<string, unknown>;
    taskRoleKeys: string[];
    priority: number;
    messageSummary: { recipientListKeys: string[]; lineListKeys: string[] };
  }>;
  agentRules: Array<{
    key: string;
    name: string;
    state: 'active' | 'suspended' | 'archived';
    executionMode: 'read_only' | 'approval' | 'unattended';
    promptKey: string;
    selectionPolicy: Record<string, unknown>;
    recipientListKeys: string[];
    lineListKeys: string[];
    priority: number;
  }>;
}

const catalog: readonly PresetDocument[] = [membershipOrganization as PresetDocument];

export const availablePresets = (): readonly PresetDocument[] => catalog;

export interface PresetApplicationSummary {
  presetId: string;
  typedLists: number;
  operationalTaskRoles: number;
  prompts: number;
  schemaRules: number;
  agentRules: number;
}

export class PresetConfigurationConflictError extends Error {
  constructor() {
    super('This Organization already has configuration. Explicitly choose to add another copy of the Preset.');
    this.name = 'PresetConfigurationConflictError';
  }
}

const requiredReference = (references: ReadonlyMap<string, string>, key: string, kind: string): string => {
  const id = references.get(key);
  if (!id) throw new Error(`Preset ${kind} reference ${key} was not found.`);
  return id;
};

const copiedName = (requested: string, used: Set<string>): string => {
  if (!used.has(requested)) {
    used.add(requested);
    return requested;
  }
  for (let copy = 2; ; copy += 1) {
    const suffix = ` (${copy})`;
    const candidate = `${requested.slice(0, 100 - suffix.length)}${suffix}`;
    if (used.has(candidate)) continue;
    used.add(candidate);
    return candidate;
  }
};

export const applyPreset = async (
  database: OrganizationDatabase,
  organizationId: string,
  presetId: string,
  options: { conflictPolicy?: 'duplicate'; applicationKey?: string } = {},
): Promise<PresetApplicationSummary> => {
  const preset = catalog.find((candidate) => candidate.id === presetId);
  if (!preset) throw new Error('Preset was not found.');
  const applicationSettingKey = options.applicationKey ? `preset-application:${options.applicationKey}` : null;
  if (applicationSettingKey) {
    const previous = await database.select({ value: settings.value }).from(settings)
      .where(eq(settings.key, applicationSettingKey)).get();
    if (previous) return JSON.parse(previous.value) as PresetApplicationSummary;
  }
  const [existingLists, existingRoles, existingPrompts, existingSchemaRules, existingAgentRules] = await Promise.all([
    database.select({ name: lists.name }).from(lists).all(),
    database.select({ name: operationalTaskRoles.displayName }).from(operationalTaskRoles).all(),
    database.select({ name: prompts.name }).from(prompts).all(),
    database.select({ name: rules.name }).from(rules).all(),
    database.select({ name: agentRules.name }).from(agentRules).all(),
  ]);
  const configured = [existingLists, existingRoles, existingPrompts, existingSchemaRules, existingAgentRules]
    .some((rows) => rows.length > 0);
  if (configured && options.conflictPolicy !== 'duplicate') throw new PresetConfigurationConflictError();
  const timestamp = new Date().toISOString();
  const listIds = new Map(preset.typedLists.map((list) => [list.key, crypto.randomUUID()]));
  const roleIds = new Map(preset.operationalTaskRoles.map((role) => [role.key, crypto.randomUUID()]));
  const promptIds = new Map(preset.prompts.map((prompt) => [prompt.key, crypto.randomUUID()]));
  const usedListNames = new Set(existingLists.map(({ name }) => name));
  const usedRoleNames = new Set(existingRoles.map(({ name }) => name));
  const usedPromptNames = new Set(existingPrompts.map(({ name }) => name));
  const usedSchemaRuleNames = new Set(existingSchemaRules.map(({ name }) => name));
  const usedAgentRuleNames = new Set(existingAgentRules.map(({ name }) => name));
  const listNames = new Map(preset.typedLists.map((list) => [list.key, copiedName(list.name, usedListNames)]));
  const roleNames = new Map(preset.operationalTaskRoles.map((role) => [role.key, copiedName(role.displayName, usedRoleNames)]));
  const promptNames = new Map(preset.prompts.map((prompt) => [prompt.key, copiedName(prompt.name, usedPromptNames)]));
  const schemaRuleNames = new Map(preset.schemaRules.map((rule) => [rule.key, copiedName(rule.name, usedSchemaRuleNames)]));
  const agentRuleNames = new Map(preset.agentRules.map((rule) => [rule.key, copiedName(rule.name, usedAgentRuleNames)]));
  const summary: PresetApplicationSummary = {
    presetId: preset.id,
    typedLists: preset.typedLists.length,
    operationalTaskRoles: preset.operationalTaskRoles.length,
    prompts: preset.prompts.length,
    schemaRules: preset.schemaRules.length,
    agentRules: preset.agentRules.length,
  };
  const statements = [
    ...preset.typedLists.map((list) => database.insert(lists).values({
      id: requiredReference(listIds, list.key, 'Typed List'),
      organizationId,
      kind: list.kind,
      name: requiredReference(listNames, list.key, 'Typed List name'),
      description: list.description,
      createdAt: timestamp,
      updatedAt: timestamp,
    })),
    ...preset.typedLists.flatMap((list) => list.items.map((item) => database.insert(listItems).values({
      id: crypto.randomUUID(),
      listId: requiredReference(listIds, list.key, 'Typed List'),
      value: item.value,
      label: item.label,
      enabled: true,
    }))),
    ...preset.operationalTaskRoles.map((role) => database.insert(operationalTaskRoles).values({
      id: requiredReference(roleIds, role.key, 'Operational Task Role'),
      displayName: requiredReference(roleNames, role.key, 'Operational Task Role name'),
      description: role.description,
      createdAt: timestamp,
      updatedAt: timestamp,
    })),
    ...preset.prompts.flatMap((prompt) => {
      const promptId = requiredReference(promptIds, prompt.key, 'Prompt');
      return [
        database.insert(prompts).values({ id: promptId, organizationId, name: requiredReference(promptNames, prompt.key, 'Prompt name'), instructions: prompt.instructions, currentRevision: 1, createdAt: timestamp, updatedAt: timestamp }),
        database.insert(promptRevisions).values({ promptId, revision: 1, instructions: prompt.instructions, createdAt: timestamp }),
      ];
    }),
    ...preset.schemaRules.flatMap((rule) => {
      const ruleId = crypto.randomUUID();
      const taskRoleIds = rule.taskRoleKeys.map((key) => requiredReference(roleIds, key, 'Operational Task Role'));
      const permittedRecipientListIds = rule.messageSummary.recipientListKeys.map((key) => requiredReference(listIds, key, 'Calendar Recipient List'));
      const permittedLineListIds = rule.messageSummary.lineListKeys.map((key) => requiredReference(listIds, key, 'LINE Destination List'));
      const selectionPolicy = JSON.stringify(rule.selectionPolicy);
      const routingPolicy = JSON.stringify(rule.routingPolicy);
      return [
        database.insert(rules).values({
          id: ruleId,
          organizationId,
          name: requiredReference(schemaRuleNames, rule.key, 'Schema Rule name'),
          status: rule.state,
          sourceListId: requiredReference(listIds, rule.sourceListKey, 'Source List'),
          selectionPolicy,
          routingPolicy,
          taskRoleIds: JSON.stringify(taskRoleIds),
          priority: rule.priority,
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
        database.insert(ruleRevisions).values({ id: crypto.randomUUID(), ruleId, revision: 1, selectionPolicy, routingPolicy, taskRoleIds: JSON.stringify(taskRoleIds), createdAt: timestamp }),
        ...permittedRecipientListIds.map((listId) => database.insert(rulePermittedRecipientLists).values({ ruleId, listId })),
        ...permittedLineListIds.map((listId) => database.insert(rulePermittedLineLists).values({ ruleId, listId })),
      ];
    }),
    ...preset.agentRules.flatMap((rule) => {
      const agentRuleId = crypto.randomUUID();
      const promptId = requiredReference(promptIds, rule.promptKey, 'Prompt');
      const selectionPolicy = JSON.stringify(rule.selectionPolicy);
      const permittedRecipientListIds = rule.recipientListKeys.map((key) => requiredReference(listIds, key, 'Calendar Recipient List'));
      const permittedLineListIds = rule.lineListKeys.map((key) => requiredReference(listIds, key, 'LINE Destination List'));
      return [
        database.insert(agentRules).values({ id: agentRuleId, organizationId, name: requiredReference(agentRuleNames, rule.key, 'Agent Rule name'), status: rule.state, executionMode: rule.executionMode, promptId, selectionPolicy, priority: rule.priority, currentRevision: 1, createdAt: timestamp, updatedAt: timestamp }),
        database.insert(agentRuleRevisions).values({ id: crypto.randomUUID(), agentRuleId, revision: 1, promptId, selectionPolicy, executionMode: rule.executionMode, permittedRecipientListIds: JSON.stringify(permittedRecipientListIds), permittedLineListIds: JSON.stringify(permittedLineListIds), createdAt: timestamp }),
        ...permittedRecipientListIds.map((listId) => database.insert(agentRulePermittedRecipientLists).values({ agentRuleId, listId })),
        ...permittedLineListIds.map((listId) => database.insert(agentRulePermittedLineLists).values({ agentRuleId, listId })),
      ];
    }),
    ...(applicationSettingKey ? [database.insert(settings).values({
      key: applicationSettingKey,
      value: JSON.stringify(summary),
      updatedAt: timestamp,
    })] : []),
  ];
  const [first, ...remaining] = statements;
  if (!first) throw new Error('Preset contains no configuration.');
  await database.batch([first, ...remaining]);
  return summary;
};

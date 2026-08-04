import { useCallback, useEffect, useRef, useState } from 'react';

/** How long a control with no other visible outcome keeps reporting that it finished. */
export const SETTLED_NOTICE_MS = 2_000;

/**
 * The identity of one in-flight operation. Every control that starts work names
 * the exact work it started, so progress is never reported on an unrelated
 * control and two controls never share one flag.
 */
export const pendingKey = {
  automationRun: 'automation:run',
  automationEnabled: 'automation:enabled',
  logout: 'session:logout',
  reauthenticate: 'session:reauthenticate',
  lineConnection: 'connection:line',
  aiConnection: 'connection:ai',
  attachmentFolder: 'connection:attachment-folder',
  aiTest: 'connection:ai-test',
  mailSearch: 'mail-test:search',
  mailPrepare: (messageId: string): string => `mail-test:prepare:${messageId}`,
  mailPreview: 'mail-test:preview',
  mailCreateEvents: 'mail-test:create-events',
  refreshPrepare: 'mail-test:refresh-prepare',
  refreshPlan: 'mail-test:refresh-plan',
  refreshApply: 'mail-test:refresh-apply',
  ruleCreate: 'rule:create',
  ruleUpdate: (ruleId: string): string => `rule:update:${ruleId}`,
  promptCreate: 'prompt:create',
  promptUpdate: (promptId: string): string => `prompt:update:${promptId}`,
  promptDelete: (promptId: string): string => `prompt:delete:${promptId}`,
  agentRuleCreate: 'agent-rule:create',
  agentRuleUpdate: (agentRuleId: string): string => `agent-rule:update:${agentRuleId}`,
  agentRunTranscript: (runId: string): string => `agent-run:transcript:${runId}`,
  actionDecision: (actionId: string, decision: string): string => `proposed-action:${actionId}:${decision}`,
  actionBatch: (runId: string, decision: string): string => `proposed-action-batch:${runId}:${decision}`,
  presetApply: (presetId: string): string => `preset:${presetId}`,
  taskUpdate: (taskId: string): string => `task:${taskId}`,
  taskRoleCreate: 'task-role:create',
  taskRoleUpdate: (roleId: string): string => `task-role:update:${roleId}`,
  taskRoleDelete: (roleId: string): string => `task-role:delete:${roleId}`,
  taskRoleAssign: (roleId: string): string => `task-role:assign:${roleId}`,
  reassignmentSuggest: 'task-reassignment:suggest',
  reassignmentApply: 'task-reassignment:apply',
  memberCreate: 'member:create',
  memberUpdate: (memberId: string): string => `member:update:${memberId}`,
  memberRefresh: 'member:refresh',
  lineDestinationSet: (memberId: string): string => `line-destination:set:${memberId}`,
  lineDestinationUnlink: (lineDestinationId: string): string => `line-destination:unlink:${lineDestinationId}`,
  lineDestinationRegister: 'line-destination:register',
  lineDestinationRemove: (lineDestinationId: string): string => `line-destination:remove:${lineDestinationId}`,
  portalAttendance: (eventId: string, status: string): string => `portal:attendance:${eventId}:${status}`,
  portalComment: (eventId: string): string => `portal:comment:${eventId}`,
  portalTask: (taskId: string): string => `portal:task:${taskId}`,
  portalRemarks: (taskId: string): string => `portal:remarks:${taskId}`,
  portalLogout: 'portal:logout',
} as const;

export interface PendingOperations {
  /** True while the named operation is running. */
  pending: (key: string) => boolean;
  /** True for a short while after the named operation succeeded. */
  settled: (key: string) => boolean;
  error: string;
  setError: (message: string) => void;
  run: (key: string, work: () => Promise<void>) => Promise<void>;
}

const withoutOne = (keys: readonly string[], key: string): readonly string[] => {
  const at = keys.indexOf(key);
  return at < 0 ? keys : [...keys.slice(0, at), ...keys.slice(at + 1)];
};

/** Tracks every operation a screen has in flight, and the error of the last one to fail. */
export const usePendingOperations = (): PendingOperations => {
  const [running, setRunning] = useState<readonly string[]>([]);
  const [succeeded, setSucceeded] = useState<readonly string[]>([]);
  const [error, setError] = useState('');
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([]);

  useEffect(() => () => {
    for (const timer of timers.current) clearTimeout(timer);
    timers.current = [];
  }, []);

  const run = useCallback(async (key: string, work: () => Promise<void>): Promise<void> => {
    setRunning((current) => [...current, key]);
    setSucceeded((current) => current.filter((finished) => finished !== key));
    setError('');
    try {
      await work();
      setSucceeded((current) => [...current, key]);
      timers.current.push(setTimeout(
        () => setSucceeded((current) => current.filter((finished) => finished !== key)),
        SETTLED_NOTICE_MS,
      ));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作に失敗しました。');
    } finally {
      setRunning((current) => withoutOne(current, key));
    }
  }, []);

  return {
    pending: (key: string): boolean => running.includes(key),
    settled: (key: string): boolean => succeeded.includes(key),
    error,
    setError,
    run,
  };
};

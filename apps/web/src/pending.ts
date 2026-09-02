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
  responseWindow: 'connection:response-window',
  aiTest: 'connection:ai-test',
  mailSearch: 'mail-test:search',
  mailPrepare: (messageId: string): string => `mail-test:prepare:${messageId}`,
  mailPreview: 'mail-test:preview',
  mailCreate: 'mail-test:create-calendar-events',
  mailStartRuleRun: 'mail-test:start-rule-run',
  refreshPrepare: 'mail-test:refresh-prepare',
  refreshPlan: 'mail-test:refresh-plan',
  refreshApply: 'mail-test:refresh-apply',
  ruleCreate: 'rule:create',
  ruleUpdate: (ruleId: string): string => `rule:update:${ruleId}`,
  ruleNoticeContacts: (ruleId: string): string => `rule:notice-contacts:${ruleId}`,
  promptCreate: 'prompt:create',
  promptUpdate: (promptId: string): string => `prompt:update:${promptId}`,
  promptDelete: (promptId: string): string => `prompt:delete:${promptId}`,
  agentRuleCreate: 'agent-rule:create',
  agentRuleUpdate: (agentRuleId: string): string => `agent-rule:update:${agentRuleId}`,
  agentRunTranscript: (runId: string): string => `agent-run:transcript:${runId}`,
  ruleRunDecision: (runId: string, decision: string): string => `rule-run:${runId}:${decision}`,
  presetApply: (presetId: string): string => `preset:${presetId}`,
  taskUpdate: (taskId: string): string => `task:${taskId}`,
  contactCreate: 'member:create',
  contactUpdate: (contactId: string): string => `member:update:${contactId}`,
  contactRefresh: 'member:refresh',
  lineDestinationSet: (contactId: string): string => `line-destination:set:${contactId}`,
  lineDestinationUnlink: (lineDestinationId: string): string => `line-destination:unlink:${lineDestinationId}`,
  lineDestinationRegister: 'line-destination:register',
  lineDestinationRemove: (lineDestinationId: string): string => `line-destination:remove:${lineDestinationId}`,
  exceptionResolve: (id: string): string => `exception:resolve:${id}`,
  accountSuspension: 'account:suspension',
  scheduleSave: 'schedule:save',
  scheduleRemove: (id: string): string => `schedule:remove:${id}`,
  scheduleRuns: (id: string): string => `schedule:runs:${id}`,
  listCreate: 'list:create',
  contactImport: 'member:import',
  portalAttendance: (eventId: string, status: string): string => `portal:attendance:${eventId}:${status}`,
  portalComment: (eventId: string): string => `portal:comment:${eventId}`,
  portalTask: (taskId: string): string => `portal:task:${taskId}`,
  portalRemarks: (taskId: string): string => `portal:remarks:${taskId}`,
  portalLogout: 'portal:logout',
} as const;

/** What the screen says it is doing, keyed by the start of an operation key. */
const OPERATION_LABELS: ReadonlyArray<readonly [string, string]> = [
  ['route:navigate', 'ページを読み込んでいます'],
  ['automation:run', 'メールを確認しています'],
  ['automation:enabled', '自動化の状態を切り替えています'],
  ['session:logout', 'ログアウトしています'],
  ['session:reauthenticate', 'Google に接続しています'],
  ['connection:ai-test', 'AI に問い合わせています'],
  ['connection:attachment-folder', '保存先を保存しています'],
  ['connection:', '接続設定を保存しています'],
  ['mail-test:search', 'Gmail を検索しています'],
  ['mail-test:prepare:', 'メール本文と添付を読み込んでいます'],
  ['mail-test:preview', 'AI が予定とタスクを抽出しています'],
  ['mail-test:start-rule-run', 'Draft Rule Run を作成しています'],
  ['mail-test:refresh-prepare', '既存の予定を照合しています'],
  ['mail-test:refresh-plan', 'AI が対応付けを判定しています'],
  ['mail-test:refresh-apply', '予定を更新しています'],
  ['rule:create', 'ルールを作成しています'],
  ['rule:update:', 'ルールを保存しています'],
  ['rule:notice-contacts:', '要約の送り先を保存しています'],
  ['prompt:create', 'Prompt を作成しています'],
  ['prompt:update:', 'Prompt を保存しています'],
  ['prompt:delete:', 'Prompt を削除しています'],
  ['agent-rule:create', 'Agent Rule を作成しています'],
  ['agent-rule:update:', 'Agent Rule を保存しています'],
  ['agent-run:transcript:', 'Run Transcript を読み込んでいます'],
  ['rule-run:', 'Rule Run を処理しています'],
  ['preset:', 'Preset を適用しています'],
  ['task:', 'タスクを保存しています'],
  ['member:create', '連絡先を登録しています'],
  ['member:update:', '連絡先を保存しています'],
  ['member:refresh', '連絡先を読み直しています'],
  ['line-destination:', 'LINE の連絡先を更新しています'],
  ['exception:resolve:', '例外を解決済みにしています'],
  ['account:suspension', 'Account の状態を変更しています'],
  ['schedule:save', '定期実行を保存しています'],
  ['schedule:remove:', '定期実行を削除しています'],
  ['schedule:runs:', '実行履歴を読み込んでいます'],
  ['list:create', 'リストを作成しています'],
  ['member:import', 'CSV を処理しています'],
  ['portal:attendance:', '出欠を送信しています'],
  ['portal:comment:', 'コメントを保存しています'],
  ['portal:task:', 'タスクを保存しています'],
  ['portal:remarks:', '備考を保存しています'],
  ['portal:logout', 'ログアウトしています'],
];

/** The key a route transition reports under, so it is named like any other work. */
export const ROUTE_NAVIGATION_KEY = 'route:navigate';

/** The sentence shown for an operation while it runs. */
export const operationLabel = (key: string): string =>
  OPERATION_LABELS.find(([prefix]) => key.startsWith(prefix))?.[1] ?? '処理しています';

export interface PendingOperations {
  /** Every operation the screen has in flight, oldest first. */
  running: readonly string[];
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
    running,
    pending: (key: string): boolean => running.includes(key),
    settled: (key: string): boolean => succeeded.includes(key),
    error,
    setError,
    run,
  };
};

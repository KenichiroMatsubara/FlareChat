import { CheckCircle2, CircleAlert, Eye, EyeOff, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { TypedList } from '@mail/domain';

import { GoogleReauthenticationAction, needsGoogleReauthentication, useAccount } from './dashboard';

/** How long a copy action keeps saying it copied before returning to its resting label. */
export const COPY_NOTICE_MS = 1_800;

export const formatted = (value: string | null): string => value
  ? new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  : 'まだ実行していません';

export const errorText = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback;

export const toggledIds = (current: string[], id: string, checked: boolean): string[] =>
  checked ? [...new Set([...current, id])] : current.filter((value) => value !== id);

/**
 * The progress an onBlur save needs: it has no button of its own to relabel, so
 * the field states that it is saving and that it saved.
 */
export const FieldSaveState = ({ saving, saved }: { saving: boolean; saved: boolean }) => saving
  ? <small className="field-state saving"><RefreshCw className="spin" size={12} />保存中…</small>
  : saved ? <small className="field-state saved"><CheckCircle2 size={12} />保存しました</small> : null;

export const SecretInput = ({ value, onChange, label, placeholder }: { value: string; onChange: (value: string) => void; label: string; placeholder: string }) => {
  const [revealed, setRevealed] = useState(false);
  return <div className="dashboard-secret"><input type="text" className={revealed ? '' : 'dashboard-secret-masked'} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} aria-label={label} autoComplete="off" autoCapitalize="none" spellCheck={false} data-1p-ignore="true" data-bwignore="true" data-lpignore="true" data-protonpass-ignore="true" /><button type="button" onClick={() => setRevealed((current) => !current)} aria-label={revealed ? `${label}を隠す` : `${label}を表示`}>{revealed ? <EyeOff size={16} /> : <Eye size={16} />}</button></div>;
};

/** Copies text to the clipboard and says so for a moment. */
export const useCopied = (): { copied: boolean; copy: (text: string) => void } => {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = (text: string): void => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), COPY_NOTICE_MS);
    });
  };
  return { copied, copy };
};

/**
 * The error of the last operation this screen ran, with the one recovery a
 * screen can offer: a revoked Google grant is fixed by reconnecting the Inbox.
 */
export const OperationError = ({ error }: { error: string }) => {
  const { reauthenticate, reauthenticating } = useAccount();
  if (!error) return null;
  return <div className="dashboard-error">
    <p><CircleAlert size={17} />{error}</p>
    {needsGoogleReauthentication(error) && <GoogleReauthenticationAction onClick={reauthenticate} busy={reauthenticating} />}
  </div>;
};

/** The Typed Lists a Rule may deliver to, kept until ADR 0147 deletes them. */
export const DestinationListChoices = ({ legend, lists, selectedIds, onChange }: {
  legend: string;
  lists: readonly TypedList[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}) => <fieldset>
  <legend>{legend}</legend>
  {lists.length
    ? lists.map((list) => <label key={list.id}><input type="checkbox" checked={selectedIds.includes(list.id)} onChange={(change) => onChange(toggledIds(selectedIds, list.id, change.target.checked))} />{list.name}<small>{list.description}</small></label>)
    : <small>利用できるリストはありません。</small>}
</fieldset>;

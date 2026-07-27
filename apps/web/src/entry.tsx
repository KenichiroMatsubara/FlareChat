import { Mail, ShieldCheck } from 'lucide-react';
import type { AppState, ProvisioningPhase } from '@mail/domain';

import type { AuthMe } from './api';

/** Uses the authenticated Google profile as the only setup-name default. */
export const defaultOrganizationName = (member: AuthMe | null): string => member?.displayName.trim() || '';

export const shouldShowOrganizationLoading = (
  member: AuthMe | null,
  organizationId: string,
  loading: boolean,
): boolean => Boolean(member?.organizations.length && (!organizationId || loading));

export const setupPhaseLabel = (phase: ProvisioningPhase | null): string => {
  if (!phase) return '準備を開始しています';
  return {
    allocating_database: '組織DBを割り当てています',
    applying_schema: '組織DBのスキーマを適用しています',
    storing_credentials: 'Automation Inbox の認証情報を組織DBへ保存しています',
    verifying_binding: '組織DBへの接続を検証しています',
    activating_organization: '組織を有効化しています',
  }[phase];
};

export const SignedOutEntry = ({
  busy,
  error,
  onSelect,
}: {
  busy: boolean;
  error: string;
  onSelect: (intent: 'login' | 'organization_setup') => void;
}) => <main className="setup-shell"><section className="setup-card login-card">
  <div className="setup-brand"><span><Mail size={22} /></span><div><strong>Mail Automation</strong><small>GMAIL TO CALENDAR</small></div></div>
  <p className="eyebrow">GOOGLE IDENTITY</p><h1>Mail Automationを開く</h1>
  <p className="setup-copy">どちらか一方を選んでください。この選択自体はGoogle認証ではなく、選んだ導線でだけOAuthを1回行います。</p>
  {error && <p className="setup-error">{error}</p>}
  <button className="primary" onClick={() => onSelect('organization_setup')} disabled={busy}>{busy ? 'Googleへ接続中…' : '新しいOrganizationを作る'}</button>
  <button className="secondary google-login entry-login" onClick={() => onSelect('login')} disabled={busy}><ShieldCheck size={18} />既存Organizationへログイン</button>
</section></main>;

export const appStateKind = (state: AppState): AppState['kind'] => state.kind;

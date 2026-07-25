import { CheckCircle2, KeyRound, Mail, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { OrganizationSetup, PasskeyCreationOptions } from '@mail/domain';

import { api } from './api';

const toBuffer = (value: string): ArrayBuffer => {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  return bytes.buffer;
};

const toBase64Url = (value: ArrayBuffer): string => {
  const binary = String.fromCharCode(...new Uint8Array(value));
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
};

const publicKeyOptions = (options: PasskeyCreationOptions): PublicKeyCredentialCreationOptions => ({
  challenge: toBuffer(options.challenge),
  rp: options.rp,
  user: { ...options.user, id: toBuffer(options.user.id) },
  pubKeyCredParams: options.pubKeyCredParams,
  timeout: options.timeout,
  authenticatorSelection: options.authenticatorSelection,
  attestation: options.attestation,
});

export const App = () => {
  const [setup, setSetup] = useState<OrganizationSetup | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(new URLSearchParams(window.location.search).get('error') ?? '');

  const refresh = async () => {
    try { setSetup(await api.currentSetup()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'セットアップ状態を取得できませんでした。'); }
  };

  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    if (setup?.status !== 'provisioning') return undefined;
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(timer);
  }, [setup?.status]);

  const start = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true); setError('');
    try { window.location.assign((await api.startSetup(name)).authorizationUrl); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Google接続を開始できませんでした。'); setBusy(false); }
  };

  const registerPasskey = async () => {
    setBusy(true); setError('');
    try {
      const options = await api.passkeyOptions();
      const credential = await navigator.credentials.create({ publicKey: publicKeyOptions(options) });
      if (!(credential instanceof PublicKeyCredential)) throw new Error('パスキーの登録がキャンセルされました。');
      const response = credential.response as AuthenticatorAttestationResponse;
      await api.verifyPasskey({
        id: credential.id,
        rawId: toBase64Url(credential.rawId),
        type: credential.type,
        response: {
          clientDataJSON: toBase64Url(response.clientDataJSON),
          attestationObject: toBase64Url(response.attestationObject),
          transports: response.getTransports?.() ?? [],
        },
      });
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'パスキーを登録できませんでした。'); }
    finally { setBusy(false); }
  };

  return <main className="setup-shell">
    <section className="setup-card">
      <div className="setup-brand"><span><Mail size={22} /></span><div><strong>Postman</strong><small>MAIL AUTOMATION</small></div></div>
      <p className="eyebrow">PRIVATE PILOT SETUP</p>
      <h1>{setup?.status === 'active' ? '組織を準備しました' : '自動化を安全に始める'}</h1>
      <p className="setup-copy">Automation Inbox、管理者パスキー、組織専用データベースを順に設定します。Gmailの管理権限と管理者のログイン情報は分離されています。</p>
      {error && <p className="setup-error">{error}</p>}
      {!setup && <form className="form-stack" onSubmit={(event) => void start(event)}>
        <label>組織名<input value={name} onChange={(event) => setName(event.target.value)} placeholder="例: 岡崎ローターアクトクラブ" required /></label>
        <button className="primary" disabled={busy}>{busy ? 'Googleへ移動中…' : 'Google Automation Inboxを接続'}</button>
      </form>}
      {setup?.status === 'awaiting_google' && <SetupStep icon={Mail} title="Googleの承認を待っています" text="開いたGoogle画面で、必要なすべての権限を許可してください。" />}
      {setup?.status === 'awaiting_passkey' && <>
        <SetupStep icon={ShieldCheck} title="Automation Inboxを確認しました" text={`${setup.inboxAddress ?? ''} はメール処理専用です。次に管理者用パスキーを登録します。`} done />
        <button className="primary" onClick={() => void registerPasskey()} disabled={busy}><KeyRound size={17} />{busy ? 'パスキーを登録中…' : '初期Ownerのパスキーを登録'}</button>
      </>}
      {setup?.status === 'provisioning' && <SetupStep icon={ShieldCheck} title="組織専用データベースを準備中" text="Cloudflare上でD1の作成・スキーマ適用・Workerバインドを検証しています。失敗時は24時間まで安全に再試行します。" />}
      {setup?.status === 'active' && <SetupStep icon={CheckCircle2} title="準備完了" text="認証済みの組織スコープと暗号化されたAutomation Inbox資格情報が利用可能です。次の実装単位で管理機能を有効化します。" done />}
      {setup?.status === 'expired' && <p className="setup-error">セットアップの有効期限が切れました。最初からやり直してください。</p>}
    </section>
  </main>;
};

const SetupStep = ({ icon: Icon, title, text, done = false }: { icon: typeof Mail; title: string; text: string; done?: boolean }) => <div className="setup-step"><span className={done ? 'done' : ''}><Icon size={19} /></span><div><strong>{title}</strong><p>{text}</p></div></div>;

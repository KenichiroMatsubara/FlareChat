import { useState } from 'react';
import { CircleAlert, MessagesSquare } from 'lucide-react';

import { api } from './api';

const errorText = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback;

/**
 * The Discord Channel's credentials. Workers cannot hold the Gateway connection
 * a bot normally reads messages on, so the endpoint below is where an Account's
 * people reach it, and it must be set in Discord for anything to arrive.
 */
export const DiscordConnection = ({ accountId }: { accountId: string }) => {
  const [botToken, setBotToken] = useState('');
  const [publicKey, setPublicKey] = useState('');
  const [interactionsUrl, setInteractionsUrl] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async (): Promise<void> => {
    setSaving(true);
    setError('');
    try {
      const saved = await api.saveDiscordConnection(accountId, {
        botToken: botToken.trim(),
        applicationPublicKey: publicKey.trim(),
      });
      setInteractionsUrl(saved.interactionsUrl);
      setBotToken('');
    } catch (cause) {
      setError(errorText(cause, 'Discord 接続を保存できませんでした。'));
    } finally {
      setSaving(false);
    }
  };

  return <section className="discord-connection">
    <h3><MessagesSquare size={18} />Discord</h3>
    <p>
      Workers は常時接続を持てないため、Discord は <b>Interactions エンドポイント</b>から届きます。
      スラッシュコマンドやボタンの操作だけが受信でき、通常のメッセージは読めません。
    </p>
    {error && <p className="chat-failure"><CircleAlert size={16} />{error}</p>}
    <form className="access-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <label>Bot トークン
        <input type="password" value={botToken} onChange={(event) => setBotToken(event.target.value)} />
      </label>
      <label>アプリケーション公開鍵
        <input value={publicKey} onChange={(event) => setPublicKey(event.target.value)} placeholder="64文字の16進数" />
      </label>
      <button type="submit" className="primary" disabled={saving || !botToken.trim() || !publicKey.trim()}>保存</button>
    </form>
    {interactionsUrl && <label className="discord-endpoint">
      Discord の Interactions Endpoint URL に設定してください
      <input readOnly value={interactionsUrl} />
    </label>}
  </section>;
};

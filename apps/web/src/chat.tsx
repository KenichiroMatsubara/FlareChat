import { useEffect, useState } from 'react';
import { CircleAlert, Plug, RefreshCw, Send, Trash2 } from 'lucide-react';

import { AccessPanel } from './access';
import { api, type ChatTurnView, type McpServerView } from './api';

const errorText = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback;

/** Renders what an exchange produced, including the tools it could not reach. */
export const ChatTranscript = (props: {
  turns: readonly ChatTurnView[];
  unreachable: ReadonlyArray<{ server: string; error: string }>;
  error: string;
}) => <>
  <div className="chat-transcript" aria-live="polite">
    {props.turns.length === 0 && <p className="chat-empty">まだやり取りがありません。</p>}
    {props.turns.map((turn) => <article key={turn.id} className="chat-turn">
      <p className="chat-request">{turn.request}</p>
      {turn.status === 'failed'
        ? <p className="chat-failure"><CircleAlert size={16} />{turn.error ?? '応答できませんでした。'}</p>
        : <p className="chat-response">{turn.response ?? '…'}</p>}
    </article>)}
  </div>
  {props.unreachable.length > 0 && <p className="chat-degraded">
    <CircleAlert size={16} />
    到達できなかった MCP Server: {props.unreachable.map((failure) => failure.server).join(', ')}。この回答はそのツールを使えていません。
  </p>}
  {props.error && <p className="chat-failure"><CircleAlert size={16} />{props.error}</p>}
</>;

/**
 * Operator Chat. One exchange is one Rule Run (ADR 0146), so what happens here
 * is recorded exactly as an unattended run is, and the tools are the Account's
 * whole set rather than a separate set written for the chat surface.
 */
export const ChatPage = ({ accountId }: { accountId: string }) => {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [turns, setTurns] = useState<ChatTurnView[]>([]);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [unreachable, setUnreachable] = useState<Array<{ server: string; error: string }>>([]);
  const [servers, setServers] = useState<McpServerView[]>([]);
  const [serverName, setServerName] = useState('');
  const [serverUrl, setServerUrl] = useState('');
  const [serverToken, setServerToken] = useState('');
  const [serverError, setServerError] = useState('');

  const reloadServers = (): void => {
    api.mcpServers(accountId).then(setServers).catch((cause: unknown) => setServerError(errorText(cause, 'MCP Server を取得できませんでした。')));
  };

  useEffect(reloadServers, [accountId]);

  const send = async (): Promise<void> => {
    const text = message.trim();
    if (!text || sending) return;
    setSending(true);
    setError('');
    try {
      const reply = await api.sendChatMessage(accountId, { conversationId, message: text });
      setConversationId(reply.conversationId);
      setUnreachable(reply.unreachableServers);
      setTurns(await api.chatTurns(accountId, reply.conversationId));
      setMessage('');
    } catch (cause) {
      setError(errorText(cause, '応答を取得できませんでした。'));
      if (conversationId) setTurns(await api.chatTurns(accountId, conversationId).catch(() => turns));
    } finally {
      setSending(false);
    }
  };

  const saveServer = async (): Promise<void> => {
    setServerError('');
    try {
      await api.saveMcpServer(accountId, crypto.randomUUID(), {
        name: serverName.trim(),
        url: serverUrl.trim(),
        token: serverToken.trim() || null,
      });
      setServerName('');
      setServerUrl('');
      setServerToken('');
      reloadServers();
    } catch (cause) {
      setServerError(errorText(cause, 'MCP Server を保存できませんでした。'));
    }
  };

  const removeServer = async (id: string): Promise<void> => {
    setServerError('');
    try {
      await api.removeMcpServer(accountId, id);
      reloadServers();
    } catch (cause) {
      setServerError(errorText(cause, 'MCP Server を削除できませんでした。'));
    }
  };

  return <section className="chat-page">
    <header className="page-heading">
      <h2>チャット</h2>
      <p>この Account のツールすべてを使って対話します。1往復が1つの Rule Run として記録されます。</p>
    </header>

    <ChatTranscript turns={turns} unreachable={unreachable} error={error} />

    <form className="chat-composer" onSubmit={(event) => { event.preventDefault(); void send(); }}>
      <label className="sr-only" htmlFor="chat-message">メッセージ</label>
      <textarea
        id="chat-message"
        value={message}
        rows={3}
        maxLength={10_000}
        disabled={sending}
        placeholder="例: 来週の予定と未回答の Contact を教えて"
        onChange={(event) => setMessage(event.target.value)}
      />
      <button type="submit" className="primary" disabled={sending || !message.trim()}>
        {sending ? <RefreshCw className="spin" size={16} /> : <Send size={16} />}
        {sending ? '応答を待っています…' : '送信'}
      </button>
    </form>

    <section className="chat-servers">
      <h3><Plug size={18} />MCP Server</h3>
      <p>リモートの HTTP / SSE サーバのみ接続できます。認証は固定トークンです。</p>
      {serverError && <p className="chat-failure"><CircleAlert size={16} />{serverError}</p>}
      <ul>
        {servers.map((server) => <li key={server.id}>
          <span className="chat-server-name">{server.name}</span>
          <span className="chat-server-url">{server.url}</span>
          <span>{server.authenticated ? 'トークンあり' : '認証なし'}</span>
          <button type="button" className="secondary" onClick={() => void removeServer(server.id)} aria-label={`${server.name} を削除`}><Trash2 size={16} /></button>
        </li>)}
      </ul>
      <form onSubmit={(event) => { event.preventDefault(); void saveServer(); }}>
        <label>名前<input value={serverName} onChange={(event) => setServerName(event.target.value)} placeholder="notion" /></label>
        <label>URL<input value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} placeholder="https://example.com/mcp" /></label>
        <label>トークン<input value={serverToken} type="password" onChange={(event) => setServerToken(event.target.value)} placeholder="任意" /></label>
        <button type="submit" className="primary" disabled={!serverName.trim() || !serverUrl.trim()}>追加</button>
      </form>
    </section>

    <AccessPanel accountId={accountId} />
  </section>;
};

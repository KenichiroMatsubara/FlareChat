import { useState } from 'react';
import { CircleAlert, MessageSquarePlus, RefreshCw, Send } from 'lucide-react';
import { useLoaderData, useRevalidator, type LoaderFunctionArgs } from 'react-router-dom';

import type { ChatTurn, Conversation } from '@mail/domain';

import { api } from '../api';
import { accountIdOf, useAccount } from '../dashboard';
import { errorText } from '../parts';

export interface ChatData {
  conversations: Conversation[];
}

export const loader = async (args: LoaderFunctionArgs): Promise<ChatData> => ({
  conversations: await api.conversations(accountIdOf(args)),
});

/** Renders what an exchange produced, including the tools it could not reach. */
export const ChatTranscript = (props: {
  turns: readonly ChatTurn[];
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
 * Operator Chat, and conversation only (ADR 0167). One exchange is one Rule
 * Run (ADR 0146), so what happens here is recorded exactly as an unattended run
 * is, and the tools are the Account's whole set.
 */
const ChatScreen = () => {
  const { conversations } = useLoaderData<ChatData>();
  const { account } = useAccount();
  const revalidator = useRevalidator();
  const accountId = account.accountId;
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [opening, setOpening] = useState('');
  const [error, setError] = useState('');
  const [unreachable, setUnreachable] = useState<Array<{ server: string; error: string }>>([]);

  const open = async (id: string): Promise<void> => {
    setOpening(id);
    setError('');
    try {
      setTurns(await api.chatTurns(accountId, id));
      setConversationId(id);
      setUnreachable([]);
    } catch (cause) {
      setError(errorText(cause, '会話を開けませんでした。'));
    } finally {
      setOpening('');
    }
  };

  const startNew = (): void => {
    setConversationId(null);
    setTurns([]);
    setUnreachable([]);
    setError('');
  };

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
      await revalidator.revalidate();
    } catch (cause) {
      setError(errorText(cause, '応答を取得できませんでした。'));
      if (conversationId) setTurns(await api.chatTurns(accountId, conversationId).catch(() => turns));
    } finally {
      setSending(false);
    }
  };

  return <section className="chat-page">
    <header className="page-heading">
      <h2>チャット</h2>
      <p>この Account のツールすべてを使って対話します。1往復が1つの Rule Run として記録されます。</p>
    </header>

    <nav className="chat-conversations" aria-label="会話">
      <button type="button" className={conversationId ? 'secondary' : 'primary'} onClick={startNew}><MessageSquarePlus size={16} />新しい会話</button>
      {conversations.map((conversation) => <button
        key={conversation.id}
        type="button"
        className={conversation.id === conversationId ? 'primary' : 'secondary'}
        disabled={opening === conversation.id}
        onClick={() => void open(conversation.id)}
      >{opening === conversation.id ? <RefreshCw className="spin" size={14} /> : null}{conversation.title || '無題の会話'}</button>)}
    </nav>

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
  </section>;
};

export default ChatScreen;

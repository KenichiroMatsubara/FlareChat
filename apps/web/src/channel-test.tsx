import { useEffect, useState } from 'react';

import { CircleAlert, CircleCheck, Plug, Send } from 'lucide-react';

import { api, type ChannelTestDelivery, type ChannelTestTarget, type McpServerToolResult, type McpServerToolView, type McpServerView } from './api';

/** What one LINE push carries, so the GUI offers exactly what the Channel can batch. */
const MESSAGE_LIMIT = 5;

const errorText = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback;

const CHANNEL_LABELS: Record<string, string> = { line: 'LINE', discord: 'Discord' };

/** Says exactly what the Channel did, because a test that only says 送信しました proves nothing. */
export const ChannelTestOutcome = ({ delivery }: { delivery: ChannelTestDelivery }) => <p className="channel-test-ok">
  <CircleCheck size={16} />
  {CHANNEL_LABELS[delivery.channel] ?? delivery.channel} が受け付けました。宛先 {delivery.destination}
  {delivery.messages > 1 ? `／${delivery.messages}通を${delivery.requests}リクエストで` : ''}
  {delivery.externalId ? `／識別子 ${delivery.externalId}` : ''}（{delivery.sentAt}）
</p>;

/**
 * Channel Test (ADR 0158).
 *
 * Sends one arbitrary message through the same seam an Automation and the MCP
 * Server send through, and calls a registered MCP Server for real, so both
 * answers are evidence about the production path rather than about a test path.
 */
export const ChannelTestPage = ({ accountId }: { accountId: string }) => {
  const [targets, setTargets] = useState<ChannelTestTarget[]>([]);
  const [contactId, setContactId] = useState('');
  const [channel, setChannel] = useState('line');
  const [texts, setTexts] = useState(['FlareChat からのテスト送信です。']);
  const [sending, setSending] = useState(false);
  const [delivery, setDelivery] = useState<ChannelTestDelivery | null>(null);
  const [error, setError] = useState('');

  const [servers, setServers] = useState<McpServerView[]>([]);
  const [serverId, setServerId] = useState('');
  const [tools, setTools] = useState<McpServerToolView[]>([]);
  const [tool, setTool] = useState('');
  const [toolArguments, setToolArguments] = useState('{}');
  const [calling, setCalling] = useState(false);
  const [result, setResult] = useState<McpServerToolResult | null>(null);
  const [serverError, setServerError] = useState('');

  useEffect(() => {
    api.channelTestTargets(accountId)
      .then((loaded) => {
        setTargets(loaded);
        setContactId((current) => current || loaded[0]?.id || '');
      })
      .catch((cause: unknown) => setError(errorText(cause, '送信先を取得できませんでした。')));
    api.mcpServers(accountId)
      .then((loaded) => {
        setServers(loaded);
        setServerId((current) => current || loaded[0]?.id || '');
      })
      .catch((cause: unknown) => setServerError(errorText(cause, 'MCP Server を取得できませんでした。')));
  }, [accountId]);

  const selected = targets.find((target) => target.id === contactId) ?? null;
  const available = selected?.channels ?? [];

  useEffect(() => {
    if (available.length && !available.includes(channel)) setChannel(available[0] ?? 'line');
  }, [available, channel]);

  const send = async (): Promise<void> => {
    setError('');
    setDelivery(null);
    setSending(true);
    try {
      setDelivery(await api.sendChannelTest(accountId, { contactId, channel, texts }));
    } catch (cause) {
      setError(errorText(cause, 'テスト送信に失敗しました。'));
    } finally {
      setSending(false);
    }
  };

  const loadTools = async (): Promise<void> => {
    setServerError('');
    setResult(null);
    try {
      const listed = await api.listMcpServerTools(accountId, serverId);
      setTools(listed.tools);
      setTool((current) => current || listed.tools[0]?.name || '');
    } catch (cause) {
      setTools([]);
      setServerError(errorText(cause, 'MCP Server のツール一覧を取得できませんでした。'));
    }
  };

  const callTool = async (): Promise<void> => {
    setServerError('');
    setResult(null);
    setCalling(true);
    try {
      const parsed = JSON.parse(toolArguments || '{}') as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('引数は JSON オブジェクトで入力してください。');
      }
      setResult(await api.callMcpServerTool(accountId, serverId, { tool, arguments: parsed as Record<string, unknown> }));
    } catch (cause) {
      setServerError(errorText(cause, 'MCP Server を呼び出せませんでした。'));
    } finally {
      setCalling(false);
    }
  };

  const schemaOf = (name: string): string => {
    const definition = tools.find((entry) => entry.name === name);
    return definition ? JSON.stringify(definition.inputSchema, null, 2) : '';
  };

  return <section className="page-layout channel-test-page">
    <header className="page-heading">
      <h2><Send size={20} />送信テスト</h2>
      <p>Automation や MCP Server が使うのと同じ経路で、任意のメッセージを 1 通だけ送ります。抑止期間は無視されるので、同じ文面を続けて試せます。</p>
    </header>

    <div className="test-card">
      <h2>Channel に送る</h2>
      <span>Contact が持っている Channel Handle を宛先にします。LINE は 5 通までを 1 リクエストにまとめて送るので、複数通にすればその挙動もそのまま確かめられます。届いた／届かなかったという結果はそのまま表示します。</span>
      <form className="access-form" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <label>送信先
          <select value={contactId} onChange={(event) => setContactId(event.target.value)}>
            {targets.length === 0 && <option value="">Channel Handle を持つ Contact がありません</option>}
            {targets.map((target) => <option key={target.id} value={target.id}>
              {target.name}（{target.channels.map((entry) => CHANNEL_LABELS[entry] ?? entry).join('・')}）
            </option>)}
          </select>
        </label>
        <label>Channel
          <select value={channel} onChange={(event) => setChannel(event.target.value)}>
            {(available.length ? available : ['line']).map((entry) => <option key={entry} value={entry}>
              {CHANNEL_LABELS[entry] ?? entry}
            </option>)}
          </select>
        </label>
        {texts.map((entry, index) => <label key={index}>
          {texts.length > 1 ? `メッセージ ${index + 1}` : 'メッセージ'}
          <textarea
            value={entry}
            rows={2}
            maxLength={1000}
            onChange={(event) => setTexts((current) => current.map((value, at) => at === index ? event.target.value : value))}
          />
        </label>)}
        <div className="channel-test-messages">
          {texts.length < MESSAGE_LIMIT && <button type="button" className="secondary" onClick={() => setTexts((current) => [...current, ''])}>
            メッセージを追加（最大 {MESSAGE_LIMIT} 通）
          </button>}
          {texts.length > 1 && <button type="button" className="secondary" onClick={() => setTexts((current) => current.slice(0, -1))}>
            最後の 1 通を消す
          </button>}
        </div>
        <button type="submit" className="primary" disabled={sending || !contactId || !texts.some((entry) => entry.trim())}>
          <Send size={16} />{sending ? '送信中…' : 'テスト送信する'}
        </button>
      </form>
      {error && <p className="chat-failure"><CircleAlert size={16} />{error}</p>}
      {delivery && <ChannelTestOutcome delivery={delivery} />}
    </div>

    <div className="test-card">
      <h2>登録した MCP Server を呼ぶ</h2>
      <span>LINE の MCP Server のように外部サーバーを登録している場合は、その tools/list と tools/call をそのまま実行して結果を確かめます。</span>
      <form className="access-form" onSubmit={(event) => { event.preventDefault(); void callTool(); }}>
        <label>MCP Server
          <select value={serverId} onChange={(event) => { setServerId(event.target.value); setTools([]); setTool(''); }}>
            {servers.length === 0 && <option value="">登録された MCP Server がありません</option>}
            {servers.map((server) => <option key={server.id} value={server.id}>{server.name}</option>)}
          </select>
        </label>
        <button type="button" className="secondary" disabled={!serverId} onClick={() => void loadTools()}>
          <Plug size={16} />ツール一覧を取得する
        </button>
        {tools.length > 0 && <label>ツール
          <select value={tool} onChange={(event) => { setTool(event.target.value); setToolArguments(schemaOf(event.target.value) ? '{}' : toolArguments); }}>
            {tools.map((entry) => <option key={entry.name} value={entry.name}>{entry.name}</option>)}
          </select>
        </label>}
        {tool && schemaOf(tool) && <pre className="channel-test-schema">{schemaOf(tool)}</pre>}
        <label>引数（JSON）
          <textarea value={toolArguments} rows={4} onChange={(event) => setToolArguments(event.target.value)} />
        </label>
        <button type="submit" className="primary" disabled={calling || !serverId || !tool}>
          <Send size={16} />{calling ? '呼び出し中…' : 'ツールを実行する'}
        </button>
      </form>
      {serverError && <p className="chat-failure"><CircleAlert size={16} />{serverError}</p>}
      {result && (result.isError
        ? <p className="chat-failure"><CircleAlert size={16} />{result.server}.{result.tool} は失敗しました: {result.text}</p>
        : <pre className="channel-test-result">{result.text || '（本文のない結果）'}</pre>)}
    </div>
  </section>;
};

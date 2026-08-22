import { useEffect, useState } from 'react';
import { CircleAlert, KeyRound, Trash2 } from 'lucide-react';

import { api, type AccessTokenView, type AccountContact, type ContactListView, type IssuedAccessToken } from './api';

const SERVER_TOOLS = ['contacts.search', 'channel.send', 'reminder.schedule'] as const;
const WINDOWS = ['none', 'hour', 'day', 'week', 'forever'] as const;

const errorText = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback;

/** Shows the credential exactly once, because only its hash is stored (ADR 0152). */
export const IssuedTokenNotice = ({ issued }: { issued: IssuedAccessToken }) => <div className="access-issued">
  <p><strong>{issued.name}</strong> を発行しました。<b>この画面を離れると二度と表示されません。</b></p>
  <label>MCP Server URL<input readOnly value={issued.url} /></label>
  <label>Access Token<input readOnly value={issued.token} /></label>
</div>;

/**
 * Issuing what an outside agent may do here: one Tool Grant and one Contact List
 * it may reach. Both bounds are set in the same place because a grant without a
 * bound list would reach every Contact the Account has.
 */
export const AccessPanel = ({ accountId }: { accountId: string }) => {
  const [contacts, setContacts] = useState<AccountContact[]>([]);
  const [lists, setLists] = useState<ContactListView[]>([]);
  const [tokens, setTokens] = useState<AccessTokenView[]>([]);
  const [issued, setIssued] = useState<IssuedAccessToken | null>(null);
  const [error, setError] = useState('');

  const [listName, setListName] = useState('');
  const [listContactIds, setListContactIds] = useState<string[]>([]);
  const [tokenName, setTokenName] = useState('');
  const [tokenListId, setTokenListId] = useState('');
  const [tokenTools, setTokenTools] = useState<string[]>([...SERVER_TOOLS]);
  const [tokenWindow, setTokenWindow] = useState<string>('day');

  const reload = (): void => {
    Promise.all([api.accountContacts(accountId), api.contactLists(accountId), api.accessTokens(accountId)])
      .then(([loadedContacts, loadedLists, loadedTokens]) => {
        setContacts(loadedContacts);
        setLists(loadedLists);
        setTokens(loadedTokens);
        setTokenListId((current) => current || loadedLists[0]?.id || '');
      })
      .catch((cause: unknown) => setError(errorText(cause, '外部連携の設定を取得できませんでした。')));
  };

  useEffect(reload, [accountId]);

  const toggle = (values: string[], value: string): string[] =>
    values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value];

  const saveList = async (): Promise<void> => {
    setError('');
    try {
      await api.saveContactList(accountId, crypto.randomUUID(), { name: listName.trim(), contactIds: listContactIds });
      setListName('');
      setListContactIds([]);
      reload();
    } catch (cause) {
      setError(errorText(cause, 'Contact List を保存できませんでした。'));
    }
  };

  const issue = async (): Promise<void> => {
    setError('');
    try {
      setIssued(await api.issueAccessToken(accountId, {
        name: tokenName.trim(),
        contactListId: tokenListId,
        tools: tokenTools,
        suppressionWindow: tokenWindow,
      }));
      setTokenName('');
      reload();
    } catch (cause) {
      setError(errorText(cause, 'Access Token を発行できませんでした。'));
    }
  };

  const revoke = async (id: string): Promise<void> => {
    setError('');
    try {
      await api.revokeAccessToken(accountId, id);
      reload();
    } catch (cause) {
      setError(errorText(cause, 'Access Token を失効できませんでした。'));
    }
  };

  return <section className="access-panel">
    <h3><KeyRound size={18} />外部 AI からの利用</h3>
    <p>Claude Cowork などの外部エージェントに、許可したツールと届けてよい相手だけを渡します。</p>
    {error && <p className="chat-failure"><CircleAlert size={16} />{error}</p>}
    {issued && <IssuedTokenNotice issued={issued} />}

    <form className="access-form" onSubmit={(event) => { event.preventDefault(); void saveList(); }}>
      <h4>届けてよい相手（Contact List）</h4>
      <label>名前<input value={listName} onChange={(event) => setListName(event.target.value)} placeholder="定例連絡の宛先" /></label>
      <fieldset>
        <legend>Contact</legend>
        {contacts.map((contact) => <label key={contact.id} className="access-check">
          <input
            type="checkbox"
            checked={listContactIds.includes(contact.id)}
            onChange={() => setListContactIds((current) => toggle(current, contact.id))}
          />
          {contact.name}
        </label>)}
      </fieldset>
      <button type="submit" className="primary" disabled={!listName.trim() || !listContactIds.length}>Contact List を保存</button>
    </form>

    <form className="access-form" onSubmit={(event) => { event.preventDefault(); void issue(); }}>
      <h4>Access Token を発行</h4>
      <label>名前<input value={tokenName} onChange={(event) => setTokenName(event.target.value)} placeholder="cowork" /></label>
      <label>届けてよい相手
        <select value={tokenListId} onChange={(event) => setTokenListId(event.target.value)}>
          {lists.map((list) => <option key={list.id} value={list.id}>{list.name}（{list.contactIds.length}名）</option>)}
        </select>
      </label>
      <fieldset>
        <legend>許可するツール</legend>
        {SERVER_TOOLS.map((tool) => <label key={tool} className="access-check">
          <input type="checkbox" checked={tokenTools.includes(tool)} onChange={() => setTokenTools((current) => toggle(current, tool))} />
          {tool}
        </label>)}
      </fieldset>
      <label>同じ送信を抑止する期間
        <select value={tokenWindow} onChange={(event) => setTokenWindow(event.target.value)}>
          {WINDOWS.map((window) => <option key={window} value={window}>{window}</option>)}
        </select>
      </label>
      <button type="submit" className="primary" disabled={!tokenName.trim() || !tokenListId || !tokenTools.length}>発行</button>
    </form>

    <ul className="access-tokens">
      {tokens.map((token) => <li key={token.id}>
        <span className="access-token-name">{token.name}</span>
        <span>{token.tools.join(', ')}</span>
        <span>{token.lastUsedAt ? `最終利用 ${token.lastUsedAt}` : '未使用'}</span>
        <button type="button" className="secondary" onClick={() => void revoke(token.id)} aria-label={`${token.name} を失効`}><Trash2 size={16} /></button>
      </li>)}
    </ul>
  </section>;
};

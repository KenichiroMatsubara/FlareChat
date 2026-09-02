import { CheckCircle2, Copy, Mail, RefreshCw, Save, Settings } from 'lucide-react';
import { useState } from 'react';
import { Link, useLoaderData, useRevalidator, type LoaderFunctionArgs } from 'react-router-dom';

import type { AccessToken, Connections, Contact, ContactList, McpServer } from '@mail/domain';

import { AccessPanel } from '../access';
import { api } from '../api';
import { McpServerPanel } from '../channel';
import { accountIdOf, useAccount } from '../dashboard';
import { DiscordConnection } from '../discord';
import { OperationError, SecretInput, useCopied } from '../parts';
import { pendingKey, usePendingOperations } from '../pending';
import { PendingOverlay } from '../progress';

export interface ConnectionsData {
  connections: Connections;
  attachmentFolder: { path: string };
  responseWindow: { days: number };
  contacts: Contact[];
  contactLists: ContactList[];
  accessTokens: AccessToken[];
  mcpServers: McpServer[];
}

export const loader = async (args: LoaderFunctionArgs): Promise<ConnectionsData> => {
  const accountId = accountIdOf(args);
  const [connections, attachmentFolder, responseWindow, contacts, contactLists, accessTokens, mcpServers] = await Promise.all([
    api.connections(accountId),
    api.attachmentFolder(accountId),
    api.responseWindow(accountId),
    api.contacts(accountId),
    api.contactLists(accountId),
    api.accessTokens(accountId),
    api.mcpServers(accountId),
  ]);
  return { connections, attachmentFolder, responseWindow, contacts, contactLists, accessTokens, mcpServers };
};

const SaveState = ({ saving, saved, resting }: { saving: boolean; saved: boolean; resting: string }) => <p className="connection-state">
  {saving ? <><RefreshCw className="spin" size={13} />保存中…</> : saved ? <><CheckCircle2 size={13} />保存しました</> : resting}
</p>;

/**
 * What the whole Account shares and no single Rule owns (ADR 0167): the AI
 * Connection, LINE and Discord, Access Tokens, MCP Servers, the attachment
 * folder, and the response-matching window. Each credential is checked where
 * it is entered.
 */
const ConnectionsScreen = () => {
  const data = useLoaderData<ConnectionsData>();
  const { account } = useAccount();
  const operations = usePendingOperations();
  const revalidator = useRevalidator();
  const accountId = account.accountId;
  const { connections } = data;
  const [lineChannelAccessToken, setLineChannelAccessToken] = useState('');
  const [lineChannelSecret, setLineChannelSecret] = useState('');
  const [aiApiKey, setAiApiKey] = useState('');
  const [aiModel, setAiModel] = useState(connections.ai.model);
  const [aiBaseUrl, setAiBaseUrl] = useState(connections.ai.baseUrl);
  const [attachmentFolderPath, setAttachmentFolderPath] = useState(data.attachmentFolder.path);
  const [responseWindowDays, setResponseWindowDays] = useState(String(data.responseWindow.days));
  const [aiTestPrompt, setAiTestPrompt] = useState('日本の首都を一文で教えてください。');
  const [aiTestResult, setAiTestResult] = useState('');
  const { copied: webhookCopied, copy: copyWebhook } = useCopied();
  const reload = (): Promise<void> => revalidator.revalidate();

  const savingAi = operations.pending(pendingKey.aiConnection);
  const savingLine = operations.pending(pendingKey.lineConnection);
  const savingFolder = operations.pending(pendingKey.attachmentFolder);
  const savingWindow = operations.pending(pendingKey.responseWindow);
  const testingAi = operations.pending(pendingKey.aiTest);
  const windowDays = Number(responseWindowDays.trim());
  const windowValid = Number.isInteger(windowDays) && windowDays >= 1 && windowDays <= 365;
  const windowChanged = windowDays !== data.responseWindow.days;
  const hasAiApi = connections.ai.apiKeyConfigured;
  const hasLineAccessToken = connections.line.channelAccessTokenConfigured;
  const hasLineSecret = connections.line.channelSecretConfigured;
  const lineChanged = Boolean(lineChannelAccessToken || lineChannelSecret);
  const lineReady = Boolean((lineChannelAccessToken || hasLineAccessToken) && (lineChannelSecret || hasLineSecret));
  const aiChanged = Boolean(aiApiKey || aiModel !== connections.ai.model || aiBaseUrl !== connections.ai.baseUrl);
  const aiReady = Boolean(aiBaseUrl.trim() && aiModel.trim() && (aiApiKey || hasAiApi));
  const webhookUrl = connections.line.webhookUrl;

  const saveLine = (): void => void operations.run(pendingKey.lineConnection, async () => {
    await api.saveLineConnection(accountId, { channelAccessToken: lineChannelAccessToken || undefined, channelSecret: lineChannelSecret || undefined });
    setLineChannelAccessToken('');
    setLineChannelSecret('');
    await reload();
  });
  const saveAi = (): void => void operations.run(pendingKey.aiConnection, async () => {
    await api.saveAiConnection(accountId, { apiKey: aiApiKey || undefined, model: aiModel, baseUrl: aiBaseUrl });
    setAiApiKey('');
    await reload();
  });
  const saveWindow = (): void => void operations.run(pendingKey.responseWindow, async () => {
    const saved = await api.saveResponseWindow(accountId, windowDays);
    setResponseWindowDays(String(saved.days));
    await reload();
  });
  const saveFolder = (): void => void operations.run(pendingKey.attachmentFolder, async () => {
    const saved = await api.saveAttachmentFolder(accountId, attachmentFolderPath);
    setAttachmentFolderPath(saved.path);
    await reload();
  });
  const testAi = (): void => void operations.run(pendingKey.aiTest, async () => {
    setAiTestResult('');
    setAiTestResult((await api.testAiConnection(accountId, aiTestPrompt)).text);
  });

  return <section className="page-layout settings-page">
    <PendingOverlay running={operations.running} />
    <OperationError error={operations.error} />
    <div className="page-title"><p>CONNECTIONS</p><h1>接続設定</h1><span>OpenAI 互換 API と LINE の資格情報はここで管理します。</span></div>
    <div className="settings-grid">
      <section className="settings-card"><div className="settings-card-title"><Settings size={19} /><div><h2>OpenAI 互換 API</h2><p>メールの予定抽出に使う AI です。</p></div></div><p className="api-guide">利用するサービスの OpenAI 互換 API の Base URL、model、API キーを入力してください。</p><label>Base URL<input value={aiBaseUrl} onChange={(event) => setAiBaseUrl(event.target.value)} placeholder="https://api.openai.com/v1" autoCapitalize="none" spellCheck={false} /></label><label>model<input value={aiModel} onChange={(event) => setAiModel(event.target.value)} placeholder="例: gpt-4.1-mini" autoCapitalize="none" spellCheck={false} /></label><label>API キー<SecretInput label="OpenAI 互換 API キー" value={aiApiKey} onChange={setAiApiKey} placeholder={hasAiApi ? '登録済み（変更時のみ入力）' : 'API キー'} /></label><div className="settings-card-actions"><SaveState saving={savingAi} saved={operations.settled(pendingKey.aiConnection)} resting={hasAiApi ? '接続設定済み' : '未設定'} /><button className="primary" onClick={saveAi} disabled={savingAi || !aiChanged || !aiReady}>{savingAi ? <RefreshCw className="spin" size={17} /> : <Save size={17} />}{savingAi ? '保存中…' : 'AI設定を保存'}</button></div></section>
      <section className="settings-card">
        <div className="settings-card-title"><Mail size={19} /><div><h2>LINE Messaging API</h2><p>LINE通知とWebhookによる宛先検出に使います。</p></div></div>
        <label>チャネルアクセストークン<SecretInput label="LINEチャネルアクセストークン" value={lineChannelAccessToken} onChange={setLineChannelAccessToken} placeholder={hasLineAccessToken ? '登録済み（変更時のみ入力）' : 'チャネルアクセストークン'} /></label>
        <label>チャネルシークレット<SecretInput label="LINEチャネルシークレット" value={lineChannelSecret} onChange={setLineChannelSecret} placeholder={hasLineSecret ? '登録済み（変更時のみ入力）' : 'チャネルシークレット'} /></label>
        <div className="line-webhook-settings">
          <label>Webhook URL<div className="line-webhook-url"><input value={webhookUrl} readOnly aria-label="LINE Webhook URL" /><button type="button" className="secondary" onClick={() => copyWebhook(webhookUrl)} disabled={!webhookUrl} aria-label="Webhook URLをコピー">{webhookCopied ? <CheckCircle2 size={15} /> : <Copy size={15} />}{webhookCopied ? 'コピーしました' : 'コピー'}</button></div></label>
          <ol>
            <li><a href="https://developers.line.biz/console/" target="_blank" rel="noreferrer">LINE Developers</a>で対象チャネルの「Messaging API設定」を開く</li>
            <li>上のURLを「Webhook URL」に貼り付けて検証する</li>
            <li>「Webhookの利用をオン」にする</li>
          </ol>
          <p className="line-webhook-result">受信したLINE IDは<Link to="../contacts">連絡先画面</Link>の「保留中のLINE連絡先」に表示されます。</p>
          {webhookUrl && !webhookUrl.startsWith('https://') && <p className="dashboard-warning">localhostはLINEから受信できません。本番の公開HTTPS URLを設定してください。</p>}
        </div>
        <div className="settings-card-actions"><SaveState saving={savingLine} saved={operations.settled(pendingKey.lineConnection)} resting={hasLineAccessToken && hasLineSecret ? '接続設定済み' : '未設定'} /><button className="primary" onClick={saveLine} disabled={savingLine || !lineChanged || !lineReady}>{savingLine ? <RefreshCw className="spin" size={17} /> : <Save size={17} />}{savingLine ? '保存中…' : 'LINE設定を保存'}</button></div>
      </section>
    </div>
    <section className="settings-card"><div className="settings-card-title"><Settings size={19} /><div><h2>返信を予定に結びつける範囲</h2><p>返信メールが「どの予定への返信か」を探す日数です。</p></div></div><p className="api-guide">出欠の返事や登録用紙の返送は、そこに書かれた日付が予定当日とずれていることがあります。この日数だけ前後を探して、一致した予定に参加者を記録します。長くすると取りこぼしは減りますが、別の予定に結びつく可能性が上がります。返信は予定の日時や場所を書き換えないため、予定そのものを更新する範囲（7日）とは別の設定です。</p><label>前後の日数<input type="number" inputMode="numeric" min={1} max={365} value={responseWindowDays} onChange={(event) => setResponseWindowDays(event.target.value)} placeholder="60" /></label><div className="settings-card-actions"><SaveState saving={savingWindow} saved={operations.settled(pendingKey.responseWindow)} resting={`現在: 前後${data.responseWindow.days}日`} /><button className="primary" onClick={saveWindow} disabled={savingWindow || !windowChanged || !windowValid}>{savingWindow ? <RefreshCw className="spin" size={17} /> : <Save size={17} />}{savingWindow ? '保存中…' : '日数を保存'}</button></div></section>
    <section className="settings-card"><div className="settings-card-title"><Settings size={19} /><div><h2>添付ファイルの保存先</h2><p>Google Driveのどこに添付ファイルを置くかを決めます。</p></div></div><p className="api-guide">「/」で階層を区切ります。ここで指定したフォルダの下に、メール1通ごとのフォルダを受信日と件名で作成します。FlareChatが作成したフォルダだけを扱うため、手作業で作った同名フォルダとは別に作成されます。</p><label>保存先<input value={attachmentFolderPath} onChange={(event) => setAttachmentFolderPath(event.target.value)} placeholder="Mail Automation/添付ファイル" autoCapitalize="none" spellCheck={false} /></label><div className="settings-card-actions"><SaveState saving={savingFolder} saved={operations.settled(pendingKey.attachmentFolder)} resting={`現在: ${data.attachmentFolder.path}`} /><button className="primary" onClick={saveFolder} disabled={savingFolder || !attachmentFolderPath.trim() || attachmentFolderPath === data.attachmentFolder.path}>{savingFolder ? <RefreshCw className="spin" size={17} /> : <Save size={17} />}{savingFolder ? '保存中…' : '保存先を保存'}</button></div></section>
    <section className="test-card"><div><p>AI CONNECTION TEST</p><h2>OpenAI 互換 API をテスト</h2><span>保存済みの接続設定を使って、任意の質問を送信します。</span></div><textarea value={aiTestPrompt} onChange={(event) => setAiTestPrompt(event.target.value)} maxLength={10_000} aria-label="APIへの質問" /><button className="secondary" onClick={testAi} disabled={testingAi || !hasAiApi}>{testingAi ? <><RefreshCw className="spin" size={14} />問い合わせ中…</> : 'API に質問する'}</button>{testingAi && <p className="field-state saving"><RefreshCw className="spin" size={12} />APIの応答を待っています…</p>}{aiTestResult && <pre>{aiTestResult}</pre>}</section>
    <DiscordConnection accountId={accountId} />
    <AccessPanel accountId={accountId} contacts={data.contacts} lists={data.contactLists} tokens={data.accessTokens} reload={reload} />
    <McpServerPanel accountId={accountId} servers={data.mcpServers} reload={reload} />
  </section>;
};

export default ConnectionsScreen;

import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useLoaderData, useRevalidator, type LoaderFunctionArgs } from 'react-router-dom';

import type { Prompt } from '@mail/domain';

import { api } from '../api';
import { accountIdOf, useAccount } from '../dashboard';
import { FieldSaveState, OperationError } from '../parts';
import { pendingKey, usePendingOperations, type PendingOperations } from '../pending';
import { PendingOverlay } from '../progress';

export interface PromptsData {
  prompts: Prompt[];
}

export const loader = async (args: LoaderFunctionArgs): Promise<PromptsData> => ({
  prompts: await api.prompts(accountIdOf(args)),
});

const PromptEditor = ({ prompt, operations, onSave, onRemove }: {
  prompt: Prompt;
  operations: PendingOperations;
  onSave: (promptId: string, input: { name: string; instructions: string }) => void;
  onRemove: (promptId: string) => void;
}) => {
  const [name, setName] = useState(prompt.name);
  const [instructions, setInstructions] = useState(prompt.instructions);
  const saving = operations.pending(pendingKey.promptUpdate(prompt.id));
  const saved = operations.settled(pendingKey.promptUpdate(prompt.id));
  const removing = operations.pending(pendingKey.promptDelete(prompt.id));
  return <article className="rule-row" aria-busy={saving || removing}>
    <div>
      <strong>{prompt.name}</strong><small>revision {prompt.revision}</small><p>{prompt.instructions}</p>
      <details>
        <summary>Promptを編集<FieldSaveState saving={saving} saved={saved} /></summary>
        <label>Prompt名<input value={name} onChange={(event) => setName(event.target.value)} disabled={saving} /></label>
        <label>Instructions<textarea value={instructions} onChange={(event) => setInstructions(event.target.value)} disabled={saving} /></label>
        <button type="button" className="secondary" disabled={saving} onClick={() => onSave(prompt.id, { name, instructions })}>{saving ? <><RefreshCw className="spin" size={13} />保存中…</> : 'Promptを保存'}</button>
      </details>
    </div>
    <button type="button" className="secondary" disabled={removing} onClick={() => onRemove(prompt.id)}>{removing ? <><RefreshCw className="spin" size={13} />削除中…</> : 'Promptを削除'}</button>
  </article>;
};

/** Prompts are shared by Agent Rules and Automations, so they are their own screen (ADR 0167). */
const PromptsScreen = () => {
  const { prompts } = useLoaderData<PromptsData>();
  const { account } = useAccount();
  const operations = usePendingOperations();
  const revalidator = useRevalidator();
  const accountId = account.accountId;
  const creating = operations.pending(pendingKey.promptCreate);
  const [promptName, setPromptName] = useState('');
  const [promptInstructions, setPromptInstructions] = useState('');
  const create = (event: React.FormEvent): void => {
    event.preventDefault();
    void operations.run(pendingKey.promptCreate, async () => {
      await api.createPrompt(accountId, { name: promptName, instructions: promptInstructions });
      setPromptName('');
      setPromptInstructions('');
      await revalidator.revalidate();
    });
  };
  const save = (promptId: string, input: { name: string; instructions: string }): void => void operations.run(pendingKey.promptUpdate(promptId), async () => {
    await api.updatePrompt(accountId, promptId, input);
    await revalidator.revalidate();
  });
  const remove = (promptId: string): void => void operations.run(pendingKey.promptDelete(promptId), async () => {
    await api.removePrompt(accountId, promptId);
    await revalidator.revalidate();
  });
  return <section className="page-layout rules-page">
    <PendingOverlay running={operations.running} />
    <OperationError error={operations.error} />
    <div className="page-title"><p>PROMPTS</p><h1>Prompt</h1><span>Agent Rule と定期実行が読む、この Account 固有の指示です。</span></div>
    <form className="rule-builder" onSubmit={create}>
      <div><p>NEW PROMPT</p><h2>Promptを作成</h2></div>
      <label>Prompt名<input required value={promptName} onChange={(event) => setPromptName(event.target.value)} /></label>
      <label>Instructions<textarea required value={promptInstructions} onChange={(event) => setPromptInstructions(event.target.value)} /></label>
      <button className="primary" disabled={creating}>{creating ? <><RefreshCw className="spin" size={14} />作成中…</> : 'Promptを作成'}</button>
    </form>
    <section className="rules-list">
      <div className="rules-list-title"><h2>登録済み Prompt</h2><span>{prompts.length}件</span></div>
      {prompts.length ? prompts.map((prompt) => <PromptEditor key={prompt.id} prompt={prompt} operations={operations} onSave={save} onRemove={remove} />) : <p className="rules-empty">まだ Prompt はありません。</p>}
    </section>
  </section>;
};

export default PromptsScreen;

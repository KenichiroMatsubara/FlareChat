import { invalid } from '../refusal';
import type { PresetApplication } from '@mail/domain';
import { resource } from '../response';
import { applyPreset, availablePresets } from '../presets';
import { accountRoute, created, sessionRoute, type Created } from './account';

export const presetRoutes = resource();

presetRoutes.get('/presets', sessionRoute(async ({ context }) =>
  context.json({ data: availablePresets().map(({ id, name, description }) => ({ id, name, description })) })));

presetRoutes.post('/organizations/:accountId/presets/:presetId/apply', accountRoute<{ conflictPolicy?: unknown }>(async (request): Promise<Created<PresetApplication>> => {
  if (request.body.conflictPolicy !== undefined && request.body.conflictPolicy !== 'duplicate') throw invalid('Unsupported Preset conflict policy.');
  return created(await applyPreset(
    request.db,
    request.accountId,
    request.params.presetId ?? '',
    request.body.conflictPolicy === 'duplicate' ? { conflictPolicy: 'duplicate' } : {},
  ));
}));

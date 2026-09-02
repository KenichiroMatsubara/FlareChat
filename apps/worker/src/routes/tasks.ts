import { invalid, notFound } from '../refusal';
import type { Task } from '@mail/domain';
import { resource } from '../response';
import { createTaskWorkflow } from '../tasks';
import { accountRoute } from './account';

export const taskRoutes = resource();

taskRoutes.get('/organizations/:accountId/tasks', accountRoute(async (request): Promise<Task[]> => {
  const assignee = request.query('assignee')?.trim();
  const event = request.query('event')?.trim();
  return createTaskWorkflow(request.db).list({
    ...(assignee === 'unassigned' ? { unassigned: true } : assignee ? { assigneeContactId: assignee } : {}),
    ...(event ? { event } : {}),
  });
}));

taskRoutes.patch('/organizations/:accountId/tasks/:taskId', accountRoute<{ completed?: unknown; remarks?: unknown; assigneeContactId?: unknown }>(async (request): Promise<Task> => {
  const input = request.body;
  if (input.completed !== undefined && typeof input.completed !== 'boolean') throw invalid('Completed must be a boolean.');
  if (input.remarks !== undefined && (typeof input.remarks !== 'string' || input.remarks.length > 10_000)) throw invalid('Remarks must be at most 10,000 characters.');
  if (input.assigneeContactId !== undefined && input.assigneeContactId !== null && typeof input.assigneeContactId !== 'string') {
    throw invalid('The assignee must be a Contact identifier or null.');
  }
  const workflow = createTaskWorkflow(request.db);
  const taskId = request.params.taskId ?? '';
  // Naming the assignee is a separate write, so a Task may be handed on and
  // completed in one request without either half deciding the other's outcome.
  let assigned: Awaited<ReturnType<typeof workflow.assign>> = null;
  if (input.assigneeContactId !== undefined) {
    assigned = await workflow.assign(taskId, (input.assigneeContactId as string | null) || null);
    if (!assigned) throw notFound('Task or Contact was not found.');
  }
  const changed = input.completed !== undefined || input.remarks !== undefined;
  const task = changed
    ? await workflow.update(taskId, {
      ...(typeof input.completed === 'boolean' ? { completed: input.completed } : {}),
      ...(typeof input.remarks === 'string' ? { remarks: input.remarks } : {}),
    })
    : assigned;
  if (!task) throw notFound('Task was not found or no change was supplied.');
  return task;
}));

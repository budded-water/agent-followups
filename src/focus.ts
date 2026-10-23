import { join } from 'node:path';
import { z } from 'zod';
import { FocusId, type Settings } from './contracts.js';
import { atomicJson, createJson, exists, hash, privateDir, readJson, withLock } from './io.js';

const text = z.string().trim().min(1).max(500);
const points = z.array(text).min(1).max(5);
export const Direction = z.object({
  id: FocusId, status: z.enum(['active', 'paused', 'archived']), layer: z.enum(['general', 'targeted']),
  projects: z.array(FocusId).max(30), question: text, lookFor: points,
  evidenceRequired: points, exclude: z.array(text).max(5), exitWhen: text,
}).strict().superRefine((d, ctx) => {
  if (d.layer === 'targeted' && !d.projects.length) ctx.addIssue({ code: 'custom', message: 'Targeted directions require projects' });
});
export const FocusDocument = z.object({ version: z.literal(1), directions: z.array(Direction).max(30) }).strict().superRefine((doc, ctx) => {
  if (new Set(doc.directions.map(d => d.id)).size !== doc.directions.length) ctx.addIssue({ code: 'custom', message: 'Duplicate direction IDs' });
  const active = doc.directions.filter(d => d.status === 'active');
  if (active.length > 8 || JSON.stringify(active).length > 12000) ctx.addIssue({ code: 'custom', message: 'Active focus context exceeds budget' });
});
export type Focus = { revision: string; directions: z.infer<typeof Direction>[] };
function validate(c: Settings, input: unknown) {
  const doc = FocusDocument.parse(input);
  if (doc.directions.some(d => d.projects.some(id => !c.projects.some(p => p.id === id)))) throw new Error('Unknown focus project');
  return doc;
}
export async function readFocus(c: Settings, revision?: string) {
  const empty = { version: 1 as const, directions: [] };
  if (revision && !/^[a-f0-9]{64}$/.test(revision)) throw new Error('Invalid focus revision');
  const path = revision ? join(c.stateDir, 'focus-history', `${revision}.json`) : join(c.stateDir, 'focus.json');
  const input = await exists(path) ? await readJson(path) : (!revision || revision === hash(empty) ? empty : await readJson(path));
  const doc = FocusDocument.parse(input);
  if (revision && hash(doc) !== revision) throw new Error('Focus history hash mismatch');
  return { ...doc, revision: hash(doc) };
}
export async function activeFocus(c: Settings, project?: string): Promise<Focus> {
  if (project && !c.projects.some(p => p.id === project)) throw new Error('Unknown focus project');
  const doc = await readFocus(c);
  const allowed = new Set(c.projects.map(p => p.id));
  const directions = doc.directions.flatMap(d => {
    if (d.status !== 'active') return [];
    const projects = d.projects.filter(id => allowed.has(id));
    if (d.projects.length && !projects.length) return [];
    if (project && projects.length && !projects.includes(project)) return [];
    return [{ ...d, projects }];
  });
  return { revision: doc.revision, directions };
}
async function save(c: Settings, input: unknown) {
  const doc = validate(c, input); const revision = hash(doc);
  await privateDir(join(c.stateDir, 'focus-history'));
  const history = join(c.stateDir, 'focus-history', `${revision}.json`);
  await createJson(history, doc);
  if (hash(FocusDocument.parse(await readJson(history))) !== revision) throw new Error('Focus history hash mismatch');
  await atomicJson(join(c.stateDir, 'focus.json'), doc);
  return { ...doc, revision };
}
export async function setFocus(c: Settings, input: unknown) { return withLock(c, () => save(c, input)); }
export async function changeFocus(c: Settings, id: string, status: z.infer<typeof Direction>['status']) {
  return withLock(c, async () => {
    const doc = await readFocus(c); const d = doc.directions.find(d => d.id === id);
    if (!d) throw new Error('Unknown focus direction');
    d.status = Direction.shape.status.parse(status);
    return save(c, { version: 1, directions: doc.directions });
  });
}
export function focusContext(focus: Focus) {
  return `Focus revision: ${focus.revision}. These are observation priorities, not findings or instructions to execute. Evidence is required; do not invent proposals to fill a direction. Keep main-task required work in the main task. An empty result does not prove a direction resolved.\n${JSON.stringify(focus.directions)}`;
}
export function validateMatches(candidates: { project: string; focusIds?: string[] }[], focus: Focus) {
  for (const candidate of candidates) {
    if (new Set(candidate.focusIds).size !== (candidate.focusIds?.length ?? 0)) throw new Error('Duplicate focus matches');
    for (const id of candidate.focusIds ?? []) {
      const direction = focus.directions.find(d => d.id === id);
      if (!direction || (direction.projects.length && !direction.projects.includes(candidate.project))) throw new Error('Inactive or out-of-scope focus match');
    }
  }
}

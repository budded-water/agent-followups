import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import { z } from 'zod';
import { Task, Evidence, type Settings } from './contracts.js';
import { atomicJson, createJson, exists, hash, readJson, withLock } from './io.js';

const Id = z.string().regex(/^[a-f0-9]{64}$/);
export const ReviewInput = z.object({
  reviewer: z.string().trim().min(1).max(200),
  verdict: z.enum(['current', 'resolved', 'duplicate', 'needs_investigation']),
  reason: z.string().trim().min(1).max(4000),
  // Operator-supplied identities, not claims that this command inspected source.
  checkedAgainst: z.array(z.object({ source: z.string().trim().min(1).max(2000), revision: z.string().trim().min(1).max(500) }).strict()).min(1).max(8),
  evidence: z.array(Evidence).min(1).max(8),
  duplicateOf: Id.optional(),
}).strict().superRefine((v, ctx) => {
  if ((v.verdict === 'duplicate') !== Boolean(v.duplicateOf)) ctx.addIssue({ code: 'custom', message: 'Only duplicate verdict requires duplicateOf' });
});
const Review = ReviewInput.safeExtend({ version: z.literal(1), proposalId: Id, subject: Id, checkedAt: z.string().datetime() });
export async function reviewTask(c: Settings, id: string) {
  Id.parse(id); const task = Task.parse(await readJson(join(c.stateDir, 'proposals', `${id}.json`)));
  if (task.id !== id) throw new Error('Proposal identity mismatch');
  return task;
}
const subject = (t: z.infer<typeof Task>) => hash({ candidate: t.candidate, eventIds: t.eventIds, parentBeads: t.parentBeads, focusRuns: t.focusRuns, provenanceArchive: t.provenanceArchive });
export async function proposalReview(c: Settings, id: string, historicalRevision?: string) {
  const task = await reviewTask(c, id); const path = join(c.stateDir, 'reviews', `${id}.json`);
  if (!historicalRevision && !await exists(path)) return { proposalId: id, state: 'unreviewed' as const };
  const revision = historicalRevision ? Id.parse(historicalRevision) : z.object({ revision: Id }).strict().parse(await readJson(path)).revision;
  const review = Review.parse(await readJson(join(c.stateDir, 'review-history', id, `${revision}.json`)));
  if (hash(review) !== revision || review.proposalId !== id) throw new Error('Review identity/hash mismatch');
  return { proposalId: id, state: review.subject === subject(task) ? 'valid' as const : 'stale' as const, revision, review };
}
export async function setProposalReview(c: Settings, id: string, input: unknown) {
  return withLock(c, async () => {
    const task = await reviewTask(c, id); const value = ReviewInput.parse(input);
    if (task.status !== 'proposed') throw new Error('Review decisions apply only to proposed tasks');
    if (!c.projects.some(p => p.id === task.candidate.project)) throw new Error('Proposal target is no longer configured');
    if (value.duplicateOf) {
      if (value.duplicateOf === id) throw new Error('Cannot duplicate itself');
      const target = await reviewTask(c, value.duplicateOf);
      if (target.candidate.project !== task.candidate.project) throw new Error('Duplicate target must belong to the same project');
      const targetReview = await proposalReview(c, target.id);
      if (targetReview.review?.verdict === 'duplicate') throw new Error('Duplicate target cannot itself be a duplicate');
    }
    // Refuse to change a canonical target into a duplicate, including stale links.
    if (value.duplicateOf) {
      const directory = join(c.stateDir, 'reviews');
      for (const file of await exists(directory) ? await readdir(directory) : []) {
        if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
        const other = await proposalReview(c, file.slice(0, -5));
        if (other.review?.duplicateOf === id) throw new Error('Proposal has incoming duplicate links');
      }
    }
    const review = Review.parse({ ...value, version: 1, proposalId: id, subject: subject(task), checkedAt: new Date().toISOString() });
    const revision = hash(review); const path = join(c.stateDir, 'review-history', id, `${revision}.json`);
    await createJson(path, review);
    if (hash(Review.parse(await readJson(path))) !== revision) throw new Error('Review history hash mismatch');
    await atomicJson(join(c.stateDir, 'reviews', `${id}.json`), { revision });
    return { revision, review };
  });
}
export async function requireCurrentReview(c: Settings, id: string) {
  const result = await proposalReview(c, id);
  if (result.state !== 'valid' || result.review?.verdict !== 'current') throw new Error('A valid current-state review is required before import');
  return result.revision!;
}
const stop = new Set('a an the and or to of in for with when after before this that from on as is are be by it its then if not'.split(' '));
const tokens = (text: string) => new Set((text.normalize('NFKC').toLocaleLowerCase('en-US').match(/[\p{L}\p{N}]+/gu) ?? []).filter(w => w.length > 2 && !stop.has(w)));
export async function similarProposals(c: Settings, id: string) {
  const task = await reviewTask(c, id);
  if (!c.projects.some(p => p.id === task.candidate.project)) throw new Error('Proposal target is no longer configured');
  const files = (await readdir(join(c.stateDir, 'proposals'))).filter(f => /^[a-f0-9]{64}\.json$/.test(f)).sort();
  if (files.length > 1000) throw new Error('Similarity scan exceeds 1000 proposals; narrow the planning store before review');
  const a = tokens(task.candidate.title + ' ' + task.candidate.rationale + ' ' + task.candidate.nextStep);
  const title = tokens(task.candidate.title);
  const sources = new Set(task.candidate.evidence.map(e => e.source.trim()));
  const suggestions = [];
  for (const file of files) {
    if (file === `${id}.json`) continue;
    const other = await reviewTask(c, file.slice(0, -5));
    if (other.candidate.project !== task.candidate.project) continue;
    const b = tokens(other.candidate.title + ' ' + other.candidate.rationale + ' ' + other.candidate.nextStep);
    const shared = [...a].filter(w => b.has(w)); const overlap = shared.length / Math.max(1, a.size + b.size - shared.length);
    const otherTitle = tokens(other.candidate.title);
    const sharedTitle = [...title].filter(w => otherTitle.has(w));
    const titleOverlap = sharedTitle.length / Math.max(1, title.size + otherTitle.size - sharedTitle.length);
    const sameSource = other.candidate.evidence.some(e => sources.has(e.source.trim()));
    if (!sameSource && !(shared.length >= 3 && overlap >= 0.12) && !(sharedTitle.length >= 3 && titleOverlap >= 0.2)) continue;
    suggestions.push({ id: other.id, title: other.candidate.title, status: other.status, score: Math.round((Math.max(overlap, titleOverlap) + (sameSource ? 0.3 : 0)) * 1000) / 1000, sameSource, sharedTitleTerms: sharedTitle.sort(), sharedTerms: shared.sort().slice(0, 12) });
  }
  return { proposalId: id, method: 'lexical-and-evidence-source', automaticMerge: false, suggestions: suggestions.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, 10) };
}

// Import-transport tests explicitly establish a current synthetic operator review.
// review.test.mjs exercises the real unreviewed/stale/rejected gate directly.
import { reviewTask, setProposalReview } from '../dist/review.js';
import { accept } from '../dist/workflow.js';
export const currentReview = { reviewer: 'synthetic test operator', verdict: 'current', reason: 'Checked isolated fixture', checkedAgainst: [{ source: 'fixture code', revision: 'fixture-v1' }], evidence: [{ source: 'fixture reproduction', summary: 'Synthetic fixture is still reproducible' }] };
export async function acceptReviewed(c, id, exec) {
  const task = await reviewTask(c, id);
  if (task.status === 'proposed' && c.projects.some(p => p.id === task.candidate.project)) await setProposalReview(c, id, currentReview);
  return accept(c, id, exec);
}

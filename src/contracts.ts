import { z } from 'zod';

const absolute = z.string().min(1).refine(v => v.startsWith('/') || /^[A-Za-z]:[\\/]/.test(v), 'Use an absolute path');
export const Config = z.object({
  version: z.literal(1),
  stateDir: absolute,
  beadsDir: absolute,
  projects: z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]+$/), root: absolute }).strict()).min(1),
  codexBinary: z.string().min(1).default('codex'),
  beadsBinary: z.string().min(1).default('bd'),
  timeoutSeconds: z.number().int().min(1).max(600).default(120),
  capturePrompts: z.boolean().default(false),
}).strict().superRefine((c, ctx) => {
  if (new Set(c.projects.map(p => p.id)).size !== c.projects.length)
    ctx.addIssue({ code: 'custom', message: 'Project IDs must be unique' });
});
export type Settings = z.infer<typeof Config>;
export const Evidence = z.object({
  summary: z.string().min(1).max(12000),
  source: z.string().min(1).max(2000),
}).strict();
export const FocusId = z.string().regex(/^[a-zA-Z0-9_-]+$/).max(80);
export const Candidate = z.object({
  title: z.string().min(1).max(160),
  project: z.string().min(1).max(100),
  kind: z.enum(['bug', 'investigation', 'improvement']),
  certainty: z.enum(['confirmed', 'hypothesis']),
  evidence: z.array(Evidence).min(1).max(8),
  rationale: z.string().min(1).max(4000),
  acceptance: z.string().min(1).max(4000),
  nextStep: z.string().min(1).max(2000),
  focusIds: z.array(FocusId).max(8).optional(),
}).strict();
export type Finding = z.infer<typeof Candidate>;
export const Extraction = z.object({
  outcome: z.enum(['candidates_found', 'no_findings']),
  candidates: z.array(Candidate).max(5),
}).strict().superRefine((r, ctx) => {
  if ((r.outcome === 'no_findings') !== (r.candidates.length === 0))
    ctx.addIssue({ code: 'custom', message: 'Outcome must agree with candidate count' });
});
export const HookInput = z.object({
  hook_event_name: z.enum(['SessionStart', 'Stop', 'UserPromptSubmit', 'Interrupt', 'SessionEnd']),
  session_id: z.string().min(1).max(200),
  turn_id: z.string().max(200).optional(),
  cwd: absolute,
  last_assistant_message: z.string().max(64000).nullable().optional(),
  prompt: z.string().max(64000).optional(),
  stop_hook_active: z.boolean().optional(),
}).passthrough();
export const Event = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  version: z.literal(1),
  createdAt: z.string(),
  project: z.string(),
  session: z.string(),
  turn: z.string().optional(),
  kind: z.enum(['Stop', 'Interrupt', 'SessionEnd', 'manual']),
  evidence: z.array(Evidence).max(10),
  parentBead: z.string().regex(/^[a-zA-Z0-9_.-]+$/).optional(),
});
export type WorkEvent = z.infer<typeof Event>;
export const Task = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  candidate: Candidate,
  eventIds: z.array(z.string()),
  parentBeads: z.array(z.string()),
  focusRuns: z.array(z.object({ eventId: z.string(), revision: z.string().regex(/^[a-f0-9]{64}$/), matchedIds: z.array(FocusId).max(8) }).strict()).default([]),
  status: z.enum(['proposed', 'accepting', 'accepted', 'rejected']),
  createdAt: z.string(),
  beadId: z.string().optional(),
  reason: z.string().optional(),
});
export type Proposal = z.infer<typeof Task>;

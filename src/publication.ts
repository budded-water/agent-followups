import { join } from 'node:path';
import { z } from 'zod';
import { Extraction, type Settings, type WorkEvent } from './contracts.js';
import { Direction, type Focus } from './focus.js';
import { createJson, exists, hash, readJson } from './io.js';

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Publication = z.object({
  version: z.literal(1), eventHash: Digest, attempt: z.string().uuid(),
  result: Extraction,
  focus: z.object({ revision: Digest, directions: z.array(Direction) }).strict(),
}).strict();
const Envelope = z.object({ revision: Digest, publication: Publication }).strict();
const path = (c: Settings, event: WorkEvent) => join(c.stateDir, 'runs', event.id, 'publication.json');

export async function readPublication(c: Settings, event: WorkEvent) {
  if (!await exists(path(c, event))) return undefined;
  const record = Envelope.parse(await readJson(path(c, event)));
  if (hash(record.publication) !== record.revision || record.publication.eventHash !== hash(event))
    throw new Error('Publication identity/hash mismatch');
  return record.publication;
}
export async function savePublication(c: Settings, event: WorkEvent, attempt: string, result: z.infer<typeof Extraction>, focus: Focus) {
  const publication = Publication.parse({ version: 1, eventHash: hash(event), attempt, result, focus });
  await createJson(path(c, event), { revision: hash(publication), publication });
  const stored = await readPublication(c, event);
  if (hash(stored) !== hash(publication)) throw new Error('Publication already exists with different content');
  return publication;
}

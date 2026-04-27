import { z } from 'zod';
import { IdSchema, ProvenanceSchema } from './common.js';
import { EquipmentSchema } from './equipment.js';
import { SequenceSchema } from './sequence.js';
export const StationSchema = z
    .object({
    id: IdSchema,
    name: z.string().min(1),
    equipment: z.array(EquipmentSchema),
    sequence: SequenceSchema,
    description: z.string().optional(),
    provenance: ProvenanceSchema.optional(),
})
    .strict();

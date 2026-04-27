import { z } from 'zod';
import {
  EquipmentTypeSchema,
  IdSchema,
  ProvenanceSchema,
} from './common.js';

export const EquipmentSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1),
    type: EquipmentTypeSchema,
    code_symbol: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/, {
      message: 'code_symbol must match /^[A-Za-z][A-Za-z0-9_]{0,63}$/',
    }),
    io_bindings: z.record(z.string().min(1), IdSchema),
    timing: z
      .record(z.string().min(1), z.number().int().nonnegative())
      .optional(),
    description: z.string().optional(),
    provenance: ProvenanceSchema.optional(),
  })
  .strict();

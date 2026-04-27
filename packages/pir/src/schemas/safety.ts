import { z } from 'zod';
import { IdSchema } from './common.js';

export const SafetyAffectRefSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('station'),
      station_id: IdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('equipment'),
      equipment_id: IdSchema,
    })
    .strict(),
]);

export const SafetyGroupSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1),
    trigger: z.string().min(1),
    affects: z.array(SafetyAffectRefSchema).min(1),
    category: z.enum([
      'emergency_stop',
      'light_curtain',
      'door',
      'two_hand',
      'other',
    ]),
    description: z.string().optional(),
  })
  .strict();

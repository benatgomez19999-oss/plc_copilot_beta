import { z } from 'zod';
import { IdSchema } from './common.js';

export const ActionSchema = z
  .object({
    target_equipment_id: IdSchema,
    verb: z.enum(['on', 'off', 'pulse', 'set']),
    pulse_ms: z.number().int().positive().optional(),
    value: z.union([z.number(), z.boolean()]).optional(),
  })
  .strict()
  .refine(
    (a) =>
      a.verb === 'pulse' ? a.pulse_ms !== undefined : a.pulse_ms === undefined,
    { message: 'pulse_ms is required iff verb is "pulse"' },
  );

// Activate entries are either a bare equipment_id or "equipment_id.activity_name".
// Format only — cross-reference + allowed_activities check lives in R-AV-01.
const ActivationRefSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{1,62}(\.[a-z_][a-z0-9_]*)?$/, {
    message: 'activate entry must match "equipment_id" or "equipment_id.activity_name"',
  });

export const ActivitySchema = z
  .object({
    activate: z.array(ActivationRefSchema).optional(),
    on_entry: z.array(ActionSchema).optional(),
    on_exit: z.array(ActionSchema).optional(),
  })
  .strict();

export const StateSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1),
    kind: z.enum(['initial', 'normal', 'terminal']),
    activity: ActivitySchema.optional(),
    description: z.string().optional(),
  })
  .strict();

export const TransitionTimeoutSchema = z
  .object({
    ms: z.number().int().positive(),
    alarm_id: IdSchema,
  })
  .strict();

const FromSchema = z.union([IdSchema, z.literal('*')]);

export const TransitionSchema = z
  .object({
    id: IdSchema,
    from: FromSchema,
    to: IdSchema,
    trigger: z.string().min(1).optional(),
    guard: z.string().min(1).optional(),
    priority: z.number().int().nonnegative(),
    timeout: TransitionTimeoutSchema.optional(),
    description: z.string().optional(),
  })
  .strict();

export const SequenceSchema = z
  .object({
    states: z.array(StateSchema).min(2),
    transitions: z.array(TransitionSchema).min(1),
  })
  .strict();

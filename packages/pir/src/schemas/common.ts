import { z } from 'zod';

export const IdSchema = z.string().regex(/^[a-z][a-z0-9_]{1,62}$/, {
  message: 'id must match /^[a-z][a-z0-9_]{1,62}$/',
});

export const SignalDirectionSchema = z.enum(['in', 'out']);
export const SignalDataTypeSchema = z.enum(['bool', 'int', 'dint', 'real']);
export const MemoryAreaSchema = z.enum(['I', 'Q', 'M', 'DB']);

export const EquipmentTypeSchema = z.enum([
  'pneumatic_cylinder_2pos',
  'pneumatic_cylinder_1pos',
  'motor_simple',
  'motor_vfd_simple',
  'valve_onoff',
  'sensor_discrete',
  'sensor_analog',
  'indicator_light',
  'supervisor',
]);

export const ProvenanceSchema = z
  .object({
    source: z.enum(['user', 'ai', 'import', 'migration']),
    created_at: z.string().min(1),
    notes: z.string().optional(),
  })
  .strict();

export const IoAddressSchema = z
  .object({
    memory_area: MemoryAreaSchema,
    byte: z.number().int().nonnegative(),
    bit: z.number().int().min(0).max(7).optional(),
    db_number: z.number().int().positive().optional(),
  })
  .strict()
  .refine((a) => (a.memory_area === 'DB' ? a.db_number !== undefined : true), {
    message: 'db_number is required when memory_area is "DB"',
  });

export const IoSignalSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1),
    direction: SignalDirectionSchema,
    data_type: SignalDataTypeSchema,
    address: IoAddressSchema,
    description: z.string().optional(),
    provenance: ProvenanceSchema.optional(),
  })
  .strict();

export const ParameterSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1),
    data_type: z.enum(['int', 'dint', 'real', 'bool']),
    default: z.union([z.number(), z.boolean()]),
    min: z.number().optional(),
    max: z.number().optional(),
    unit: z.string().optional(),
    description: z.string().optional(),
  })
  .strict()
  .refine(
    (p) => p.min === undefined || p.max === undefined || p.min <= p.max,
    { message: 'min must be ≤ max' },
  );

export const RecipeSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1),
    values: z.record(IdSchema, z.union([z.number(), z.boolean()])),
    description: z.string().optional(),
  })
  .strict();

export const InterlockSchema = z
  .object({
    id: IdSchema,
    inhibits: z.string().regex(/^[a-z][a-z0-9_]+\.[a-z_][a-z0-9_]*$/, {
      message: 'inhibits must match "equipment_id.action_name"',
    }),
    when: z.string().min(1),
    description: z.string().optional(),
  })
  .strict();

export const NamingProfileSchema = z
  .object({
    equipment_symbol_pattern: z.string().optional(),
    io_symbol_pattern: z.string().optional(),
  })
  .strict();

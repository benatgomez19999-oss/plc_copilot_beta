import { z } from 'zod';
import { IdSchema, InterlockSchema, IoSignalSchema, NamingProfileSchema, ParameterSchema, ProvenanceSchema, RecipeSchema, } from './common.js';
import { StationSchema } from './station.js';
import { AlarmSchema } from './alarm.js';
import { SafetyGroupSchema } from './safety.js';
export const MachineSchema = z
    .object({
    id: IdSchema,
    name: z.string().min(1),
    description: z.string().optional(),
    stations: z.array(StationSchema).min(1),
    io: z.array(IoSignalSchema),
    alarms: z.array(AlarmSchema),
    interlocks: z.array(InterlockSchema),
    parameters: z.array(ParameterSchema),
    recipes: z.array(RecipeSchema),
    safety_groups: z.array(SafetyGroupSchema),
    naming: NamingProfileSchema.optional(),
})
    .strict();
export const ProjectSchema = z
    .object({
    pir_version: z.literal('0.1.0'),
    id: IdSchema,
    name: z.string().min(1),
    machines: z.array(MachineSchema).min(1).max(1),
    description: z.string().optional(),
    provenance: ProvenanceSchema.optional(),
})
    .strict();

import { z } from 'zod';
import { IdSchema } from './common.js';

export const AlarmSchema = z
  .object({
    id: IdSchema,
    severity: z.enum(['info', 'warn', 'critical']),
    text_i18n: z
      .record(z.string().min(1), z.string().min(1))
      .refine((m) => typeof m['en'] === 'string' && m['en'].length > 0, {
        message: 'text_i18n must include a non-empty "en" entry',
      }),
    when: z.string().min(1).optional(),
    ack_required: z.boolean().default(true),
    category: z.string().optional(),
    description: z.string().optional(),
  })
  .strict();

import { ProjectSchema, type Project } from '@plccopilot/pir';

export type ReadProjectResult =
  | { ok: true; project: Project }
  | { ok: false; error: string };

/**
 * Read a `File` from an `<input type="file">`, parse it as JSON, and run it
 * through `ProjectSchema.safeParse`. Returns a discriminated result so the
 * caller can render the failure inline without throwing.
 */
export async function readProjectFromFile(
  file: File,
): Promise<ReadProjectResult> {
  let text: string;
  try {
    text = await file.text();
  } catch (e) {
    return { ok: false, error: `cannot read file: ${describe(e)}` };
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${describe(e)}` };
  }

  const parsed = ProjectSchema.safeParse(json);
  if (!parsed.success) {
    const lines = parsed.error.issues
      .slice(0, 8)
      .map((i) => `  • ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    const tail =
      parsed.error.issues.length > 8
        ? `\n  … (+${parsed.error.issues.length - 8} more)`
        : '';
    return {
      ok: false,
      error: `PIR schema validation failed:\n${lines}${tail}`,
    };
  }

  return { ok: true, project: parsed.data };
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

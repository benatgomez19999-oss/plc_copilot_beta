import { describe, expect, it } from 'vitest';
import fixture from '../../pir/src/fixtures/weldline.json';
import type { Project } from '@plccopilot/pir';
import { generateDbGlobalParams } from '../src/generators/db-params.js';
import { generateDbRecipes } from '../src/generators/db-recipes.js';
import { CodegenError } from '../src/types.js';

function clone(): Project {
  return structuredClone(fixture) as unknown as Project;
}

describe('generateDbGlobalParams', () => {
  it('emits a DATA_BLOCK with PIR parameters + defaults', () => {
    const a = generateDbGlobalParams(clone());
    expect(a).not.toBeNull();
    const c = a!.content;
    expect(a!.path).toBe('siemens/DB_Global_Params.scl');
    expect(a!.kind).toBe('scl');
    expect(c).toContain('DATA_BLOCK "DB_Global_Params"');
    expect(c).toContain("S7_Optimized_Access := 'TRUE'");
    expect(c).toContain('p_weld_time : DInt');
    expect(c).toContain('p_weld_current : Real');
    expect(c).toContain('p_weld_time := 3000;');
    expect(c).toContain('p_weld_current := 150.0;');
    expect(c).toContain('END_DATA_BLOCK');
  });

  it('serializes bool parameters as TRUE / FALSE', () => {
    const p = clone();
    p.machines[0]!.parameters.push({
      id: 'p_debug',
      name: 'Debug mode',
      data_type: 'bool',
      default: true,
    });
    p.machines[0]!.parameters.push({
      id: 'p_verbose',
      name: 'Verbose',
      data_type: 'bool',
      default: false,
    });
    const c = generateDbGlobalParams(p)!.content;
    expect(c).toContain('p_debug : Bool');
    expect(c).toContain('p_debug := TRUE;');
    expect(c).toContain('p_verbose := FALSE;');
  });

  it('forces a decimal point on real defaults', () => {
    const p = clone();
    p.machines[0]!.parameters.push({
      id: 'p_rate',
      name: 'Integer-ish real',
      data_type: 'real',
      default: 2,
    });
    const c = generateDbGlobalParams(p)!.content;
    expect(c).toContain('p_rate := 2.0;');
  });

  it('returns null when the machine has no parameters', () => {
    const p = clone();
    p.machines[0]!.parameters = [];
    expect(generateDbGlobalParams(p)).toBeNull();
  });

  it('orders fields alphabetically by id', () => {
    const a = generateDbGlobalParams(clone())!.content;
    const currentPos = a.indexOf('p_weld_current');
    const timePos = a.indexOf('p_weld_time');
    expect(currentPos).toBeGreaterThan(-1);
    expect(timePos).toBeGreaterThan(currentPos);
  });
});

describe('generateDbRecipes', () => {
  it('flattens each recipe/parameter pair into <recipeId>_<paramId>', () => {
    const a = generateDbRecipes(clone());
    expect(a).not.toBeNull();
    const c = a!.content;
    expect(a!.path).toBe('siemens/DB_Recipes.scl');
    expect(c).toContain('DATA_BLOCK "DB_Recipes"');
    expect(c).toContain('r_default_p_weld_time : DInt');
    expect(c).toContain('r_default_p_weld_current : Real');
    expect(c).toContain('r_default_p_weld_time := 3000;');
    expect(c).toContain('r_default_p_weld_current := 150.0;');
    expect(c).toContain('END_DATA_BLOCK');
  });

  it('returns null when the machine has no recipes', () => {
    const p = clone();
    p.machines[0]!.recipes = [];
    expect(generateDbRecipes(p)).toBeNull();
  });

  it('serializes bool recipe values as TRUE / FALSE', () => {
    const p = clone();
    p.machines[0]!.parameters.push({
      id: 'p_debug',
      name: 'Debug',
      data_type: 'bool',
      default: false,
    });
    p.machines[0]!.recipes[0]!.values = {
      ...p.machines[0]!.recipes[0]!.values,
      p_debug: true,
    };
    const c = generateDbRecipes(p)!.content;
    expect(c).toContain('r_default_p_debug : Bool');
    expect(c).toContain('r_default_p_debug := TRUE;');
  });

  it('throws UNKNOWN_PARAMETER if a recipe references a missing parameter', () => {
    const p = clone();
    (p.machines[0]!.recipes[0]!.values as Record<string, number | boolean>)[
      'p_ghost'
    ] = 1;
    expect(() => generateDbRecipes(p)).toThrow(CodegenError);
    try {
      generateDbRecipes(p);
    } catch (e) {
      expect((e as CodegenError).code).toBe('UNKNOWN_PARAMETER');
    }
  });

  it('is deterministic across calls', () => {
    const a = generateDbRecipes(clone())!.content;
    const b = generateDbRecipes(clone())!.content;
    expect(a).toBe(b);
  });
});

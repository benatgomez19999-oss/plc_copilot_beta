import type { Parameter, Project } from '../../domain/types.js';
import { addIssue, type ValidationReport } from '../report.js';
import type { ValidationContext } from '../context.js';

type ParamValue = number | boolean;

export function matchesParameterType(param: Parameter, value: ParamValue): boolean {
  if (param.data_type === 'bool') return typeof value === 'boolean';
  if (typeof value !== 'number') return false;
  if (!Number.isFinite(value)) return false;
  if (param.data_type === 'int' || param.data_type === 'dint') {
    return Number.isInteger(value);
  }
  return true; // 'real' accepts any finite number
}

export function isWithinRange(param: Parameter, value: ParamValue): boolean {
  if (typeof value !== 'number') return true;
  if (param.min !== undefined && value < param.min) return false;
  if (param.max !== undefined && value > param.max) return false;
  return true;
}

function renderRange(p: Parameter): string {
  return `[${p.min ?? '-inf'}, ${p.max ?? '+inf'}]`;
}

export function runParameterRules(
  _project: Project,
  ctx: ValidationContext,
  report: ValidationReport,
): void {
  const base = `$.machines[0]`;

  // R-PR-02 — Parameter.default matches dtype + range
  ctx.machine.parameters.forEach((p, pIdx) => {
    const pp = `${base}.parameters[${pIdx}]`;
    if (!matchesParameterType(p, p.default)) {
      addIssue(report, {
        rule: 'R-PR-02',
        severity: 'error',
        path: `${pp}.default`,
        message: `default ${JSON.stringify(p.default)} does not match parameter "${p.id}" dtype "${p.data_type}"`,
      });
      return;
    }
    if (!isWithinRange(p, p.default)) {
      addIssue(report, {
        rule: 'R-PR-02',
        severity: 'error',
        path: `${pp}.default`,
        message: `default ${String(p.default)} for "${p.id}" is outside range ${renderRange(p)}`,
      });
    }
  });

  // R-PR-01 — Recipe values reference existing Parameters; value dtype + range compatible
  ctx.machine.recipes.forEach((r, rIdx) => {
    for (const [key, value] of Object.entries(r.values)) {
      const path = `${base}.recipes[${rIdx}].values.${key}`;
      const p = ctx.parameters_by_id.get(key);
      if (!p) {
        addIssue(report, {
          rule: 'R-PR-01',
          severity: 'error',
          path,
          message: `recipe "${r.id}" references unknown parameter "${key}"`,
        });
        continue;
      }
      if (!matchesParameterType(p, value)) {
        addIssue(report, {
          rule: 'R-PR-01',
          severity: 'error',
          path,
          message: `value ${JSON.stringify(value)} does not match parameter "${key}" dtype "${p.data_type}"`,
        });
        continue;
      }
      if (!isWithinRange(p, value)) {
        addIssue(report, {
          rule: 'R-PR-01',
          severity: 'error',
          path,
          message: `value ${String(value)} is outside range ${renderRange(p)} for parameter "${key}"`,
        });
      }
    }
  });
}

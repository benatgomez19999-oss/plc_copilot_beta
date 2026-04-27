import type { Project } from '../../domain/types.js';
import { addIssue, type ValidationReport } from '../report.js';
import type { ValidationContext } from '../context.js';

export function runIoRules(
  _project: Project,
  ctx: ValidationContext,
  report: ValidationReport,
): void {
  const base = `$.machines[0]`;

  for (const [raw, signals] of ctx.io_by_raw_address) {
    if (signals.length > 1) {
      for (const s of signals) {
        const idx = ctx.machine.io.indexOf(s);
        addIssue(report, {
          rule: 'R-IO-01',
          severity: 'error',
          path: `${base}.io[${idx}].address`,
          message: `address ${raw} is used by multiple signals: ${signals
            .map((x) => x.id)
            .join(', ')}`,
        });
      }
    }
  }

  ctx.machine.io.forEach((io, i) => {
    const p = `${base}.io[${i}]`;

    if (io.address.memory_area === 'I' && io.direction !== 'in') {
      addIssue(report, {
        rule: 'R-IO-03',
        severity: 'error',
        path: `${p}.direction`,
        message: `memory_area "I" requires direction "in"`,
      });
    }
    if (io.address.memory_area === 'Q' && io.direction !== 'out') {
      addIssue(report, {
        rule: 'R-IO-03',
        severity: 'error',
        path: `${p}.direction`,
        message: `memory_area "Q" requires direction "out"`,
      });
    }

    if (io.data_type === 'bool' && io.address.bit === undefined) {
      addIssue(report, {
        rule: 'R-IO-04',
        severity: 'error',
        path: `${p}.address`,
        message: `bool signals require an explicit bit`,
      });
    }
    if (io.data_type !== 'bool' && io.address.bit !== undefined) {
      addIssue(report, {
        rule: 'R-IO-04',
        severity: 'error',
        path: `${p}.address`,
        message: `non-bool signals must not declare a bit`,
      });
    }
  });
}

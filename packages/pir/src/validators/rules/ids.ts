import type { Project } from '../../domain/types.js';
import { addIssue, type ValidationReport } from '../report.js';
import type { ValidationContext } from '../context.js';

const ID_RE = /^[a-z][a-z0-9_]{1,62}$/;

function checkIdShape(
  report: ValidationReport,
  path: string,
  id: string,
): void {
  if (!ID_RE.test(id)) {
    addIssue(report, {
      rule: 'R-ID-01',
      severity: 'error',
      path,
      message: `id "${id}" does not match /^[a-z][a-z0-9_]{1,62}$/`,
    });
  }
}

function uniq(
  report: ValidationReport,
  rule: string,
  entityName: string,
  items: readonly { id: string }[],
  pathOf: (index: number) => string,
): void {
  const seen = new Map<string, number>();
  items.forEach((it, idx) => {
    const prev = seen.get(it.id);
    if (prev !== undefined) {
      addIssue(report, {
        rule,
        severity: 'error',
        path: pathOf(idx),
        message: `duplicate ${entityName} id "${it.id}" (also at ${pathOf(prev)})`,
      });
    } else {
      seen.set(it.id, idx);
    }
  });
}

export function runIdRules(
  project: Project,
  ctx: ValidationContext,
  report: ValidationReport,
): void {
  const m = ctx.machine;
  const base = `$.machines[0]`;

  checkIdShape(report, `$.id`, project.id);
  checkIdShape(report, `${base}.id`, m.id);

  uniq(report, 'R-ID-05', 'station', m.stations, (i) => `${base}.stations[${i}]`);
  uniq(report, 'R-ID-05', 'alarm', m.alarms, (i) => `${base}.alarms[${i}]`);
  uniq(report, 'R-ID-05', 'interlock', m.interlocks, (i) => `${base}.interlocks[${i}]`);
  uniq(report, 'R-ID-05', 'parameter', m.parameters, (i) => `${base}.parameters[${i}]`);
  uniq(report, 'R-ID-05', 'recipe', m.recipes, (i) => `${base}.recipes[${i}]`);
  uniq(report, 'R-ID-05', 'safety_group', m.safety_groups, (i) => `${base}.safety_groups[${i}]`);

  uniq(report, 'R-ID-02', 'io_signal', m.io, (i) => `${base}.io[${i}]`);

  m.stations.forEach((station, sIdx) => {
    const sPath = `${base}.stations[${sIdx}]`;
    checkIdShape(report, `${sPath}.id`, station.id);

    station.equipment.forEach((eq, eIdx) => {
      checkIdShape(report, `${sPath}.equipment[${eIdx}].id`, eq.id);
    });

    uniq(
      report,
      'R-ID-04',
      'state',
      station.sequence.states,
      (i) => `${sPath}.sequence.states[${i}]`,
    );

    uniq(
      report,
      'R-SM-09',
      'transition',
      station.sequence.transitions,
      (i) => `${sPath}.sequence.transitions[${i}]`,
    );

    station.sequence.states.forEach((st, stIdx) => {
      checkIdShape(report, `${sPath}.sequence.states[${stIdx}].id`, st.id);
    });
    station.sequence.transitions.forEach((tr, tIdx) => {
      checkIdShape(report, `${sPath}.sequence.transitions[${tIdx}].id`, tr.id);
    });
  });

  const seenEq = new Map<string, string>();
  m.stations.forEach((station, sIdx) => {
    station.equipment.forEach((eq, eIdx) => {
      const p = `${base}.stations[${sIdx}].equipment[${eIdx}]`;
      const prev = seenEq.get(eq.id);
      if (prev !== undefined) {
        addIssue(report, {
          rule: 'R-ID-03',
          severity: 'error',
          path: p,
          message: `duplicate equipment id "${eq.id}" (also at ${prev})`,
        });
      } else {
        seenEq.set(eq.id, p);
      }
    });
  });

  m.io.forEach((io, i) => checkIdShape(report, `${base}.io[${i}].id`, io.id));
  m.alarms.forEach((a, i) => checkIdShape(report, `${base}.alarms[${i}].id`, a.id));
  m.interlocks.forEach((x, i) => checkIdShape(report, `${base}.interlocks[${i}].id`, x.id));
  m.parameters.forEach((p, i) => checkIdShape(report, `${base}.parameters[${i}].id`, p.id));
  m.recipes.forEach((r, i) => checkIdShape(report, `${base}.recipes[${i}].id`, r.id));
  m.safety_groups.forEach((g, i) =>
    checkIdShape(report, `${base}.safety_groups[${i}].id`, g.id),
  );
}

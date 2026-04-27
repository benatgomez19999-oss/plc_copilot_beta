import type { Project } from '../domain/types.js';
import { buildContext } from './context.js';
import { emptyReport, type ValidationReport } from './report.js';
import { runIdRules } from './rules/ids.js';
import { runIoRules } from './rules/io.js';
import { runSequenceRules } from './rules/sequence.js';
import { runSafetyRules } from './rules/safety.js';
import { runEquipmentRules } from './rules/equipment.js';
import { runParameterRules } from './rules/parameters.js';
import { runExpressionRules } from './rules/expressions.js';

export { emptyReport, addIssue } from './report.js';
export type { Issue, Severity, ValidationReport } from './report.js';
export { buildContext, machinePath, rawAddress } from './context.js';
export type { ValidationContext } from './context.js';

export function validate(project: Project): ValidationReport {
  const report = emptyReport();
  const ctx = buildContext(project);
  runIdRules(project, ctx, report);
  runIoRules(project, ctx, report);
  runSequenceRules(project, ctx, report);
  runSafetyRules(project, ctx, report);
  runEquipmentRules(project, ctx, report);
  runParameterRules(project, ctx, report);
  runExpressionRules(project, ctx, report);
  return report;
}

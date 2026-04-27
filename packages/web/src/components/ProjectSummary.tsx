import type { Project } from '@plccopilot/pir';

export interface ProjectSummaryProps {
  project: Project;
  fileName?: string | undefined;
}

interface MachineCounts {
  stations: number;
  equipment: number;
  io: number;
  alarms: number;
  parameters: number;
  recipes: number;
}

function machineCounts(p: Project): MachineCounts {
  let stations = 0;
  let equipment = 0;
  let io = 0;
  let alarms = 0;
  let parameters = 0;
  let recipes = 0;
  for (const m of p.machines) {
    stations += m.stations.length;
    for (const s of m.stations) equipment += s.equipment.length;
    io += m.io.length;
    alarms += m.alarms.length;
    parameters += m.parameters.length;
    recipes += m.recipes.length;
  }
  return { stations, equipment, io, alarms, parameters, recipes };
}

export function ProjectSummary({
  project,
  fileName,
}: ProjectSummaryProps): JSX.Element {
  const c = machineCounts(project);
  return (
    <section className="card">
      <h2>Project Summary</h2>
      <table className="kv">
        <tbody>
          <tr>
            <th>id</th>
            <td>{project.id}</td>
          </tr>
          <tr>
            <th>name</th>
            <td>{project.name}</td>
          </tr>
          <tr>
            <th>pir_version</th>
            <td>{project.pir_version}</td>
          </tr>
          {fileName ? (
            <tr>
              <th>file</th>
              <td>{fileName}</td>
            </tr>
          ) : null}
          <tr>
            <th>machines</th>
            <td>{project.machines.length}</td>
          </tr>
          <tr>
            <th>stations</th>
            <td>{c.stations}</td>
          </tr>
          <tr>
            <th>equipment</th>
            <td>{c.equipment}</td>
          </tr>
          <tr>
            <th>io</th>
            <td>{c.io}</td>
          </tr>
          <tr>
            <th>alarms</th>
            <td>{c.alarms}</td>
          </tr>
          <tr>
            <th>parameters</th>
            <td>{c.parameters}</td>
          </tr>
          <tr>
            <th>recipes</th>
            <td>{c.recipes}</td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}

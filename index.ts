import { Command } from "commander";

const SNYK_API_BASE = "https://api.snyk.io/rest";
const SNYK_API_HOST = "https://api.snyk.io";
const SNYK_API_V1 = "https://api.snyk.io/v1";
const SNYK_API_VERSION = "2026-03-25";

interface SnykProject {
  id: string;
  attributes: {
    name: string;
    status: string;
    type: string;
    origin: string;
    created: string;
  };
}

interface SnykProjectsResponse {
  data: SnykProject[];
  links?: {
    next?: string;
  };
}

function getAuthHeaders(accept = "application/vnd.api+json"): Record<string, string> {
  const pat = process.env.SNYK_PAT;
  if (!pat) {
    console.error("Error: SNYK_PAT is not set in .env");
    process.exit(1);
  }
  return {
    Authorization: `Token ${pat}`,
    Accept: accept,
  };
}

async function fetchProjects(
  orgId: string,
  namesStartWith?: string[]
): Promise<SnykProject[]> {
  const params = new URLSearchParams({ version: SNYK_API_VERSION });

  if (namesStartWith && namesStartWith.length > 0) {
    for (const prefix of namesStartWith) {
      params.append("names_start_with[]", prefix);
    }
  }

  const allProjects: SnykProject[] = [];
  let url: string | null =
    `${SNYK_API_BASE}/orgs/${orgId}/projects?${params}`;

  while (url) {
    const response = await fetch(url, { headers: getAuthHeaders() });

    if (!response.ok) {
      const body = await response.text();
      console.error(
        `Error ${response.status} from Snyk API: ${body}`
      );
      process.exit(1);
    }

    const payload = (await response.json()) as SnykProjectsResponse;
    allProjects.push(...payload.data);

    // Follow pagination cursors (links.next is already a full path like /rest/orgs/...)
    url = payload.links?.next
      ? `${SNYK_API_HOST}${payload.links.next}`
      : null;
  }

  return allProjects;
}

async function setProjectStatus(
  orgId: string,
  project: SnykProject,
  status: "active" | "inactive"
): Promise<void> {
  const action = status === "active" ? "activate" : "deactivate";
  const url = `${SNYK_API_V1}/org/${orgId}/project/${project.id}/${action}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...getAuthHeaders("application/json"),
      "Content-Type": "application/json",
    },
    body: "{}",
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${response.status} for project "${project.attributes.name}": ${body}`);
  }
}

function repoFromProjectName(projectName: string): string | null {
  // e.g. "KantarProfiles/busi-opportunity(main):Dockerfile" → "KantarProfiles/busi-opportunity"
  const match = projectName.match(/^([^(]+)\(/);
  return match ? match[1].trim() : null;
}

async function verifyHooks(projects: SnykProject[], status: "active" | "inactive" | "report"): Promise<void> {
  const repos = [...new Set(
    projects.map(p => repoFromProjectName(p.attributes.name)).filter(Boolean) as string[]
  )];

  const heading = status === "report" ? "GitHub webhooks" : "Verifying GitHub webhooks";
  console.log(`\n${heading} for ${repos.length} repo(s)...`);

  for (const repo of repos) {
    const proc = Bun.spawn(["gh", "api", `repos/${repo}/hooks`], { stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;

    if (proc.exitCode !== 0) {
      console.error(`  ✗ ${repo}: failed to fetch hooks — ${err.trim()}`);
      continue;
    }

    const hooks: Array<{ id: number; config?: { url?: string }; active?: boolean }> = JSON.parse(out);
    const snykHook = hooks.find(h => h.config?.url?.includes("api.snyk.io"));

    if (status === "report") {
      const hookStatus = snykHook ? `present (id=${snykHook.id}, active=${snykHook.active})` : "absent";
      console.log(`  ${repo}: Snyk webhook ${hookStatus}`);
    } else if (status === "active") {
      if (snykHook) {
        console.log(`  ✓ ${repo}: Snyk webhook present (id=${snykHook.id}, active=${snykHook.active})`);
      } else {
        console.error(`  ✗ ${repo}: Snyk webhook NOT found`);
      }
    } else {
      if (!snykHook) {
        console.log(`  ✓ ${repo}: Snyk webhook not found`);
      } else {
        console.error(`  ✗ ${repo}: Snyk webhook still present (id=${snykHook.id}, active=${snykHook.active})`);
      }
    }
  }
}

function printProjects(projects: SnykProject[]): void {
  if (projects.length === 0) {
    console.log("No projects found.");
    return;
  }

  const rows = projects.map(p => [p.attributes.name, p.attributes.status, p.attributes.type]);
  const headers = ["Name", "Status", "Type"];
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map(r => r[i].length))
  );

  const fmt = (row: string[]) =>
    row.map((cell, i) => cell.padEnd(widths[i])).join("  ");
  const divider = widths.map(w => "-".repeat(w)).join("  ");

  console.log(`Found ${projects.length} project(s):\n`);
  console.log(fmt(headers));
  console.log(divider);
  for (const row of rows) console.log(fmt(row));
}

function getOrgId(): string {
  const orgId = process.env.SNYK_ORG_ID;
  if (!orgId) {
    console.error("Error: SNYK_ORG_ID is not set in .env");
    process.exit(1);
  }
  return orgId;
}

const program = new Command();

program
  .name("snyk-recycle")
  .description("CLI tool to manage Snyk project activation states")
  .version("0.1.0");

program
  .command("list")
  .description("List projects in the organisation")
  .option(
    "--names-start-with <prefixes...>",
    "Filter projects whose names start with the given prefix(es)"
  )
  .action(async (options: { namesStartWith?: string[] }) => {
    const orgId = getOrgId();

    console.log(`Fetching projects for org: ${orgId}`);
    if (options.namesStartWith) {
      console.log(`Filtering by prefix(es): ${options.namesStartWith.join(", ")}`);
    }
    console.log();

    const projects = await fetchProjects(orgId, options.namesStartWith);
    printProjects(projects);
    if (projects.length > 0) await verifyHooks(projects, "report");
  });

program
  .command("activate")
  .description("Activate projects matching the given name prefix(es)")
  .option(
    "--names-start-with <prefixes...>",
    "Filter projects whose names start with the given prefix(es)"
  )
  .action((options) => runStatusChange(options, "active"));

program
  .command("deactivate")
  .description("Deactivate projects matching the given name prefix(es)")
  .option(
    "--names-start-with <prefixes...>",
    "Filter projects whose names start with the given prefix(es)"
  )
  .action((options) => runStatusChange(options, "inactive"));

program.parse();

async function runStatusChange(
  options: { namesStartWith?: string[] },
  status: "active" | "inactive"
): Promise<void> {
  const orgId = getOrgId();
  const verb = status === "active" ? "Activating" : "Deactivating";
  const pastVerb = status === "active" ? "activated" : "deactivated";

  console.log(`Fetching projects for org: ${orgId}`);
  if (options.namesStartWith) {
    console.log(`Filtering by prefix(es): ${options.namesStartWith.join(", ")}`);
  }
  console.log();

  const projects = await fetchProjects(orgId, options.namesStartWith);
  if (projects.length === 0) {
    console.log("No projects found.");
    return;
  }

  console.log(`${verb} ${projects.length} project(s)...`);
  let ok = 0, failed = 0;
  for (const project of projects) {
    try {
      await setProjectStatus(orgId, project, status);
      console.log(`  ✓ ${project.attributes.name}`);
      ok++;
    } catch (err) {
      console.error(`  ✗ ${(err as Error).message}`);
      failed++;
    }
  }
  console.log(`\nDone. ${ok} ${pastVerb}, ${failed} failed.`);

  await verifyHooks(projects, status);
}
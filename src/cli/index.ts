import { parseArgs } from "node:util";
import { taskCommand } from "./commands/task.js";
import { agentsListCommand, agentsUpdateCommand, agentsRemoveCommand } from "./commands/agents.js";
import { statusCommand } from "./commands/status.js";
import { historyCommand } from "./commands/history.js";
import { statsCommand } from "./commands/stats.js";
import { auditAgentsCommand, auditCommitsCommand } from "./commands/audit.js";
import type { OutputFormat } from "./output.js";

const USAGE = `Usage: haol <command> [options]

Commands:
  task <prompt>              Submit a task and print the result
  status <task_id>           Show task lifecycle and status
  agents list                List all agents
  agents update <id>         Update agent fields
  agents remove <id>         Soft-delete an agent
  history                    Show recent task history
  stats                      Dashboard summary (cost, latency, failures)
  audit agents               Agent registry changes
  audit commits              Recent Dolt commits

Options:
  --tier <n>                 Override complexity tier (1-4)
  --cap <a,b>                Override capabilities (comma-separated)
  --status <status>          Filter agents by status / set agent status
  --last <n>                 Limit history/commit results
  --agent <id>               Filter history by agent
  --hours <n>                Stats time window (default: 24)
  --since <duration>         Audit time window, e.g. 7d, 24h (default: 7d)
  --format <table|json|min>  Output format (default: table)
  --base-url <url>           API base URL (default: http://localhost:3000)
  --help                     Show this help message
`;

export async function run(argv: string[]): Promise<string> {
  // Extract command and positional args before parseArgs
  const args = argv.slice(2); // strip node + script path

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    return USAGE;
  }

  const command = args[0];
  const rest = args.slice(1);

  // Parse common options
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      tier: { type: "string", short: "t" },
      cap: { type: "string", short: "c" },
      status: { type: "string", short: "s" },
      last: { type: "string", short: "n" },
      agent: { type: "string", short: "a" },
      hours: { type: "string" },
      since: { type: "string" },
      format: { type: "string", short: "f" },
      "base-url": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) return USAGE;

  const format = (
    values.format === "json"
      ? "json"
      : values.format === "min" || values.format === "minimal"
        ? "minimal"
        : "table"
  ) as OutputFormat;

  const baseUrl = (values["base-url"] as string) ?? "http://localhost:3000";

  switch (command) {
    case "task": {
      const prompt = positionals.join(" ");
      if (!prompt) {
        return 'Error: prompt is required.\n\nUsage: haol task "your prompt here" [--tier N] [--cap a,b]';
      }
      const tier = values.tier ? parseInt(values.tier as string, 10) : undefined;
      const capabilities = values.cap
        ? (values.cap as string).split(",").map((s) => s.trim())
        : undefined;
      return taskCommand({ prompt, tier, capabilities, format, baseUrl });
    }

    case "status": {
      const taskId = positionals[0];
      if (!taskId) {
        return "Error: task_id is required.\n\nUsage: haol status <task_id>";
      }
      return statusCommand({ taskId, format, baseUrl });
    }

    case "agents": {
      const subcommand = positionals[0] ?? "list";
      switch (subcommand) {
        case "list":
          return agentsListCommand({
            status: values.status as string | undefined,
            format,
            baseUrl,
          });
        case "update": {
          const agentId = positionals[1];
          if (!agentId) {
            return "Error: agent_id is required.\n\nUsage: haol agents update <id> [--status disabled]";
          }
          return agentsUpdateCommand({
            agentId,
            status: values.status as string | undefined,
            format,
            baseUrl,
          });
        }
        case "remove": {
          const agentId = positionals[1];
          if (!agentId) {
            return "Error: agent_id is required.\n\nUsage: haol agents remove <id>";
          }
          return agentsRemoveCommand(agentId, baseUrl, format);
        }
        default:
          return `Unknown agents subcommand: ${subcommand}\n\nUsage: haol agents list|update|remove`;
      }
    }

    case "history": {
      const last = values.last ? parseInt(values.last as string, 10) : undefined;
      return historyCommand({
        last,
        agent: values.agent as string | undefined,
        format,
        baseUrl,
      });
    }

    case "stats": {
      const hours = values.hours ? parseInt(values.hours as string, 10) : undefined;
      return statsCommand({ hours, format, baseUrl });
    }

    case "audit": {
      const subcommand = positionals[0];
      if (!subcommand) {
        return "Error: subcommand required.\n\nUsage: haol audit agents|commits";
      }
      switch (subcommand) {
        case "agents":
          return auditAgentsCommand({
            since: values.since as string | undefined,
            format,
            baseUrl,
          });
        case "commits": {
          const last = values.last ? parseInt(values.last as string, 10) : undefined;
          return auditCommitsCommand({ last, format, baseUrl });
        }
        default:
          return `Unknown audit subcommand: ${subcommand}\n\nUsage: haol audit agents|commits`;
      }
    }

    default:
      return `Unknown command: ${command}\n${USAGE}`;
  }
}

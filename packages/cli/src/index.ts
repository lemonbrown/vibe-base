#!/usr/bin/env node
import { Command } from "commander";
import {
  cmdAgent,
  cmdAgentLink,
  cmdAgentSetWorkspace,
  cmdAgentStatus,
  cmdApps,
  cmdCi,
  cmdContext,
  cmdDelete,
  cmdDeploy,
  cmdDetect,
  cmdDoctor,
  cmdGithubConnect,
  cmdInit,
  cmdInvite,
  cmdLogin,
  cmdLogs,
  cmdOpen,
  cmdPlatform,
  cmdPlatformApp,
  cmdQuery,
  cmdShip,
  cmdRollback,
  cmdStatus,
  handleError,
} from "./commands.js";

const program = new Command();
program
  .name("vibe")
  .description("Vibe Base — build, deploy, and operate private apps from your local workflow.")
  .version("0.1.0");

function wrap(fn: (...args: never[]) => Promise<void>) {
  return (...args: unknown[]) => {
    fn(...(args as never[])).catch(handleError);
  };
}

program
  .command("login")
  .description("Save control-plane URL and owner token")
  .requiredOption("--url <url>", "control-plane base URL")
  .requiredOption("--token <token>", "owner token")
  .action(wrap((opts: { url: string; token: string }) => cmdLogin(opts.url, opts.token)));

program
  .command("init")
  .description("Scaffold vibe.app.yaml, AGENTS.md, and .vibe-memory")
  .option("--name <name>", "app name")
  .option("--github", "also create a GitHub repo and wire up CI deploys")
  .option("--private", "make the GitHub repo private (default)", true)
  .option("--public", "make the GitHub repo public")
  .action(
    wrap((opts: { name?: string; github?: boolean; private?: boolean; public?: boolean }) =>
      cmdInit({ ...opts, private: opts.public ? false : opts.private })
    )
  );

program.command("detect").description("Show detected runtime").action(wrap(cmdDetect));
program.command("doctor").description("Check the project for problems").action(wrap(cmdDoctor));

program
  .command("ship")
  .description("Deploy: connect to GitHub on first run, then commit + push (one command)")
  .option("-m, --message <message>", "commit message")
  .action(wrap((opts: { message?: string }) => cmdShip(opts)));

program
  .command("ci")
  .description("Wait for the GitHub Actions build to finish; print logs on failure")
  .action(wrap(cmdCi));

program
  .command("deploy")
  .description("Build and deploy the app (or --image to deploy a prebuilt image)")
  .option("--image <ref>", "deploy a prebuilt image instead of building")
  .action(wrap((opts: { image?: string }) => cmdDeploy(opts)));

program
  .command("status")
  .description("Show live app status")
  .option("--json", "output JSON")
  .action(wrap((opts: { json?: boolean }) => cmdStatus(!!opts.json)));

program
  .command("logs")
  .description("Show app logs")
  .option("--build", "show the build log instead of runtime logs")
  .action(wrap((opts: { build?: boolean }) => cmdLogs(!!opts.build)));

program
  .command("context")
  .description("Print a compact context pack for an LLM")
  .option("--json", "output JSON")
  .action(wrap((opts: { json?: boolean }) => cmdContext(!!opts.json)));

program
  .command("invite <email>")
  .description("Invite a user; returns a claim link to share")
  .option("--role <role>", "owner | leader | member", "member")
  .action(wrap((email: string, opts: { role: string }) => cmdInvite(email, opts.role)));

program
  .command("delete")
  .description("Permanently delete this app: container, database, storage, routing, and records")
  .option("-y, --yes", "skip the confirmation prompt")
  .action(wrap((opts: { yes?: boolean }) => cmdDelete(opts)));

program.command("apps").description("List all apps").action(wrap(cmdApps));
program.command("open").description("Open the deployed app in a browser").action(wrap(cmdOpen));

const deploy = program.commands.find((c) => c.name() === "deploy")!;
deploy
  .command("rollback")
  .description("Roll back to the previous deployment")
  .action(wrap(cmdRollback));

const platform = program
  .command("platform")
  .description("Read-only view of the live platform (for you and LLMs)")
  .option("--json", "output JSON")
  .action(wrap((opts: { json?: boolean }) => cmdPlatform(!!opts.json)));
platform
  .command("app <id>")
  .description("Detailed, secret-free view of a single app")
  .option("--json", "output JSON")
  .action(wrap((id: string, opts: { json?: boolean }) => cmdPlatformApp(id, !!opts.json)));

program
  .command("query [model]")
  .description("Run a declared read-model against an app's live data (omit model to list)")
  .option("--app <id>", "target app id (defaults to the app in this directory)")
  .option("-p, --param <key=value>", "query parameter (repeatable)", (v: string, acc: string[]) => {
    acc.push(v);
    return acc;
  }, [] as string[])
  .option("--json", "output JSON")
  .action(
    wrap((model: string | undefined, opts: { app?: string; param?: string[]; json?: boolean }) =>
      cmdQuery(model, opts)
    )
  );

const agent = program
  .command("agent")
  .description("Run the on-machine daemon that runs your selected local LLM for portal chat jobs")
  .option("--name <name>", "name to register this machine under")
  .action(wrap((opts: { name?: string }) => cmdAgent(opts)));
agent
  .command("set-workspace <path>")
  .description("Set the base directory where the agent creates new app folders")
  .action(wrap((path: string) => cmdAgentSetWorkspace(path)));
agent
  .command("link <appId> <path>")
  .description("Map an existing app id to a local directory")
  .action(wrap((appId: string, path: string) => cmdAgentLink(appId, path)));
agent
  .command("status")
  .description("Show the agent's workspace + linked apps")
  .action(wrap(cmdAgentStatus));

const github = program.command("github").description("GitHub integration");
github
  .command("connect")
  .description("Create a GitHub repo for this app and wire up CI deploys")
  .option("--private", "make the repo private (default)", true)
  .option("--public", "make the repo public")
  .action(
    wrap((opts: { private?: boolean; public?: boolean }) =>
      cmdGithubConnect({ private: opts.public ? false : opts.private })
    )
  );

program.parseAsync(process.argv);

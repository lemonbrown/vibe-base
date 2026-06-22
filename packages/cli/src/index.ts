#!/usr/bin/env node
import { Command } from "commander";
import {
  cmdApps,
  cmdContext,
  cmdDeploy,
  cmdDetect,
  cmdDoctor,
  cmdInit,
  cmdInvite,
  cmdLogin,
  cmdLogs,
  cmdOpen,
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
  .action(wrap((opts: { name?: string }) => cmdInit(opts)));

program.command("detect").description("Show detected runtime").action(wrap(cmdDetect));
program.command("doctor").description("Check the project for problems").action(wrap(cmdDoctor));
program.command("deploy").description("Build and deploy the app").action(wrap(cmdDeploy));

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

program.command("apps").description("List all apps").action(wrap(cmdApps));
program.command("open").description("Open the deployed app in a browser").action(wrap(cmdOpen));

const deploy = program.commands.find((c) => c.name() === "deploy")!;
deploy
  .command("rollback")
  .description("Roll back to the previous deployment")
  .action(wrap(cmdRollback));

program.parseAsync(process.argv);

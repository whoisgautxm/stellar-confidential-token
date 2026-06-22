#!/usr/bin/env node
import { Command } from "commander";
import { loadConfig } from "./config.js";

const program = new Command();
program
  .name("ctoken")
  .description("Confidential Token CLI for Stellar")
  .version("0.1.0");

program
  .command("config")
  .description("Print current CLI config (sanitized)")
  .action(() => {
    const cfg = loadConfig();
    console.log(
      JSON.stringify(
        {
          network: cfg.network.network,
          source: cfg.source.publicKey(),
          chainId: cfg.chainId.toString(),
          contractIds: cfg.contractIds,
          artifactsDir: cfg.artifactsDir,
        },
        null,
        2,
      ),
    );
  });

program
  .command("register")
  .description("Register sender BabyJubJub public key with the registrar")
  .action(async () => {
    await import("./commands/register.js");
  });

program
  .command("deposit <amount>")
  .description("Deposit SAC amount, encrypt with BabyJubJub")
  .action(async (amount: string) => {
    process.env.CTOKEN_AMOUNT = amount;
    await import("./commands/deposit.js");
  });

program
  .command("transfer <to> <amount>")
  .description("Private transfer to another registered user")
  .action(async (to: string, amount: string) => {
    process.env.CTOKEN_TO = to;
    process.env.CTOKEN_AMOUNT = amount;
    // Also expose as positional args so the command can be invoked directly via
    // `npx tsx packages/cli/src/commands/transfer.ts <to> <amount>`.
    process.argv[2] = to;
    process.argv[3] = amount;
    await import("./commands/transfer.js");
  });

program
  .command("withdraw <amount>")
  .description("Withdraw and unwrap to SAC")
  .action(async (amount: string) => {
    process.env.CTOKEN_AMOUNT = amount;
    process.argv[2] = amount;
    await import("./commands/withdraw.js");
  });

program
  .command("balance [user]")
  .description(
    "Fetch encrypted balance; decrypt + dlog if [user] is the source account",
  )
  .action(async (user?: string) => {
    if (user) process.argv[2] = user;
    await import("./commands/balance.js");
  });

program.parseAsync(process.argv);

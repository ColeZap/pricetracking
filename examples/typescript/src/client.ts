import yargs from "yargs";
import Client, {
  CommitmentLevel,
  SubscribeRequest,
  SubscribeRequestFilterAccountsFilter,
} from "@triton-one/yellowstone-grpc";

import bs58 from "bs58";
import { UiTokenAmount } from "@triton-one/yellowstone-grpc/dist/grpc/solana-storage";

const PING_INTERVAL_MS = 30000;
const WALLET_ADRESSES = ["BNgbVmeQ2PejSBVa4mu8uixwRJhQwSYoFyunXr7tX5Gy"];

async function main() {
  const args = parseCommandLineArgs() as any;

  // Open connection.
  const client = new Client(args.endpoint, args.xToken, {
    "grpc.max_receive_message_length": 64 * 1024 * 1024, // 64MiB
  });

  const commitment = parseCommitmentLevel(args.commitment);

  // Execute a requested command
  switch (args["_"][0]) {
    case "ping":
      console.log("response: " + (await client.ping(1)));
      break;

    case "get-version":
      console.log("response: " + (await client.getVersion()));
      break;

    case "get-slot":
      console.log("response: " + (await client.getSlot(commitment)));
      break;

    case "get-block-height":
      console.log("response: " + (await client.getBlockHeight(commitment)));
      break;

    case "get-latest-blockhash":
      console.log("response: ", await client.getLatestBlockhash(commitment));
      break;

    case "is-blockhash-valid":
      console.log("response: ", await client.isBlockhashValid(args.blockhash));
      break;

    case "subscribe":
      await subscribeCommand(client, args);
      break;

    default:
      console.error(
        `Unknown command: ${args["_"]}. Use "--help" for a list of supported commands.`
      );
      break;
  }
}

function parseCommitmentLevel(commitment: string | undefined) {
  if (!commitment) {
    return;
  }
  const typedCommitment =
    commitment.toUpperCase() as keyof typeof CommitmentLevel;
  return CommitmentLevel[typedCommitment];
}

async function subscribeCommand(client: any, args: any) {
  // Subscribe for events
  const stream = await client.subscribe();

  // Create `error` / `end` handler
  const streamClosed = new Promise<void>((resolve, reject) => {
    stream.on("error", (error: any) => {
      reject(error);
      stream.end();
    });
    stream.on("end", () => {
      resolve();
    });
    stream.on("close", () => {
      resolve();
    });
  });

  // Handle updates
  stream.on("data", (data) => {
    const preBalances = [];
    const postBalances = [];
    const finalBalances = [];
    const sender = [];
    const receiver = [];

    if (data.transaction) {
      console.log(
        "signature",
        bs58.encode(data.transaction.transaction.signature)
      );

      if (
        data.transaction.transaction.meta.preTokenBalances.length === 0 &&
        data.transaction.transaction.meta.postTokenBalances.length === 0
      ) {
        console.log("sending or receiving SOL");

        data.transaction.transaction.transaction.message.accountKeys.forEach(
          (key, i) => {
            finalBalances.push({
              mint: "So11111111111111111111111111111111111111112",
              owner: bs58.encode(key),
              uiTokenAmount: {
                uiAmount:
                  (Number(data.transaction.transaction.meta.postBalances[i]) -
                    Number(data.transaction.transaction.meta.preBalances[i])) /
                  1e9,
                decimals: 9,
                amount: (
                  Number(data.transaction.transaction.meta.postBalances[i]) -
                  Number(data.transaction.transaction.meta.preBalances[i])
                ).toString(),
              },
            });
          }
        );
        finalBalances.forEach((item) => {
          if (item.uiTokenAmount.uiAmount < 0) {
            sender.push({
              ...item,
              uiTokenAmount: {
                ...item.uiTokenAmount,
                uiAmount: Math.abs(
                  item.uiTokenAmount.uiAmount +
                    Number(data.transaction.transaction.meta.fee) / 1e9
                ),
                amount: Math.abs(
                  Number(item.uiTokenAmount.amount) +
                    Number(data.transaction.transaction.meta.fee)
                ).toString(),
              },
            });
          } else if (item.uiTokenAmount.uiAmount > 0) {
            receiver.push(item);
          }
        });

        console.log("sender info:", sender);
        if (
          sender.filter((item) => WALLET_ADRESSES.includes(item.owner))
            .length === 0
        ) {
          console.log(
            "receiver info:",
            receiver.filter((item) => WALLET_ADRESSES.includes(item.owner))
          );
        } else {
          console.log("receiver info", receiver);
        }

        return;
      }

      if (
        data.transaction.transaction.meta.logMessages.includes(
          "Program log: Instruction: Swap"
        )
      ) {
        let signerWallet = bs58.encode(
          data.transaction.transaction.transaction.message.accountKeys[0]
        );

        data.transaction.transaction.meta.preTokenBalances.forEach((item) => {
          if (item.owner === signerWallet) {
            preBalances.push(item);
          }
        });
        data.transaction.transaction.meta.postTokenBalances.forEach((item) => {
          if (item.owner === signerWallet) {
            postBalances.push(item);
          }
        });
        //if theres only 1 pre and 1 post balance, you must have swapped SOL and another token
        if (preBalances.length + postBalances.length === 2) {
          if (preBalances[0].mint === postBalances[0].mint) {
            const solValueWithFee =
              Number(data.transaction.transaction.meta.preBalances[0]) -
              Number(data.transaction.transaction.meta.postBalances[0]);
            const solAmountTransacted =
              Math.abs(
                solValueWithFee - Number(data.transaction.transaction.meta.fee)
              ) / 1e9;
            console.log(
              "users SOL amount remaining:",
              Number(data.transaction.transaction.meta.postBalances[0]) / 1e9
            );

            console.log("sol amount in transaction", solAmountTransacted);

            let decimals = postBalances[0].uiTokenAmount.decimals;

            let uiAmount =
              (Number(postBalances[0].uiTokenAmount.amount) -
                Number(preBalances[0].uiTokenAmount.amount)) /
              10 ** decimals;

            let amount =
              Number(postBalances[0].uiTokenAmount.amount) -
              Number(preBalances[0].uiTokenAmount.amount);

            if (uiAmount === 0) {
              return;
            }

            const tokenPriceMultiplier = 1 / uiAmount;
            const currentPrice = solAmountTransacted * tokenPriceMultiplier;

            finalBalances.push({
              mint: postBalances[0].mint,
              owner: signerWallet,
              type: amount > 0 ? "Buy" : "Sell",
              uiTokenAmount: {
                uiAmount: Math.abs(uiAmount),
                decimals,
                amount: Math.abs(amount).toString(),
                price: currentPrice,
              },
            });
            console.log("final balances", finalBalances);
            finalBalances[0].type === "Buy"
              ? console.log("Sol amount spent: ", solAmountTransacted)
              : console.log("Sol amount gained: ", solAmountTransacted);
            return;
          }
        }
      }

      if (
        !data.transaction.transaction.meta.logMessages.includes(
          "Program log: Instruction: Swap"
        )
      ) {
        if (
          data.transaction.transaction.meta.preTokenBalances.length +
            data.transaction.transaction.meta.postTokenBalances.length >
          2
        ) {
          console.log("sending or receiving a token other than SOL");
          data.transaction.transaction.meta.preTokenBalances.forEach((item) => {
            preBalances.push(item);
          });
          data.transaction.transaction.meta.postTokenBalances.forEach(
            (item) => {
              postBalances.push(item);
            }
          );
          postBalances.forEach((postBalance) => {
            let preBalance = preBalances.find(
              (item) =>
                item.owner === postBalance.owner &&
                item.mint === postBalance.mint
            );
            if (preBalance) {
              finalBalances.push({
                owner: postBalance.owner,
                mint: postBalance.mint,
                uiTokenAmount: {
                  uiAmount:
                    (Number(postBalance.uiTokenAmount.amount) -
                      Number(preBalance.uiTokenAmount.amount)) /
                    10 ** postBalance.uiTokenAmount.decimals,
                  decimals: postBalance.uiTokenAmount.decimals,
                  amount: (
                    Number(postBalance.uiTokenAmount.amount) -
                    Number(preBalance.uiTokenAmount.amount)
                  ).toString(),
                },
              });
            }
          });
          finalBalances.forEach((item) => {
            if (item.uiTokenAmount.uiAmount < 0) {
              sender.push({
                ...item,
                uiTokenAmount: {
                  ...item.uiTokenAmount,
                  uiAmount: Math.abs(item.uiTokenAmount.uiAmount),
                  amount: Math.abs(
                    Number(item.uiTokenAmount.amount)
                  ).toString(),
                },
              });
            } else if (item.uiTokenAmount.uiAmount > 0) {
              receiver.push(item);
            }
          });
          console.log("sender info:", sender);
          if (
            sender.filter((item) => WALLET_ADRESSES.includes(item.owner))
              .length === 0
          ) {
            console.log(
              "receiver info:",
              receiver.filter((item) => WALLET_ADRESSES.includes(item.owner))
            );
          } else {
            console.log("receiver info", receiver);
          }
          return;
        }
      }
    }
  });

  // Create subscribe request based on provided arguments.
  const request: SubscribeRequest = {
    accounts: {},
    slots: {},
    transactions: {
      myTransactionFilter: {
        accountInclude: WALLET_ADRESSES,
        accountExclude: [],
        accountRequired: [],
        vote: false,
        failed: false,
      },
    },
    transactionsStatus: {},
    entry: {},
    blocks: {},
    blocksMeta: {},
    accountsDataSlice: [],
    ping: undefined,
  };
  if (args.accounts) {
    const filters: SubscribeRequestFilterAccountsFilter[] = [];

    if (args.accounts.memcmp) {
      for (let filter in args.accounts.memcmp) {
        const filterSpec = filter.split(",", 1);
        if (filterSpec.length != 2) {
          throw new Error("invalid memcmp");
        }

        const [offset, data] = filterSpec;
        filters.push({
          memcmp: { offset, base58: data.trim() },
        });
      }
    }

    if (args.accounts.tokenaccountstate) {
      filters.push({
        tokenAccountState: args.accounts.tokenaccountstate,
      });
    }

    if (args.accounts.datasize) {
      filters.push({ datasize: args.accounts.datasize });
    }

    request.accounts.client = {
      account: args.accountsAccount,
      owner: args.accountsOwner,
      filters,
    };
  }

  if (args.slots) {
    request.slots.client = {
      filterByCommitment: args.slotsFilterByCommitment,
    };
  }

  if (args.transactions) {
    request.transactions.client = {
      vote: args.transactionsVote,
      failed: args.transactionsFailed,
      signature: args.transactionsSignature,
      accountInclude: args.transactionsAccountInclude,
      accountExclude: args.transactionsAccountExclude,
      accountRequired: args.transactionsAccountRequired,
    };
  }

  if (args.transactionsStatus) {
    request.transactionsStatus.client = {
      vote: args.transactionsStatusVote,
      failed: args.transactionsStatusFailed,
      signature: args.transactionsStatusSignature,
      accountInclude: args.transactionsStatusAccountInclude,
      accountExclude: args.transactionsStatusAccountExclude,
      accountRequired: args.transactionsStatusAccountRequired,
    };
  }

  if (args.entry) {
    request.entry.client = {};
  }

  if (args.blocks) {
    request.blocks.client = {
      accountInclude: args.blocksAccountInclude,
      includeTransactions: args.blocksIncludeTransactions,
      includeAccounts: args.blocksIncludeAccounts,
      includeEntries: args.blocksIncludeEntries,
    };
  }

  if (args.blocksMeta) {
    request.blocksMeta.client = {
      account_include: args.blocksAccountInclude,
    };
  }

  if (args.accounts.dataslice) {
    for (let filter in args.accounts.dataslice) {
      const filterSpec = filter.split(",", 1);
      if (filterSpec.length != 2) {
        throw new Error("invalid data slice");
      }

      const [offset, length] = filterSpec;
      request.accountsDataSlice.push({
        offset,
        length,
      });
    }
  }

  if (args.ping) {
    request.ping = { id: args.ping };
  }

  // Send subscribe request
  await new Promise<void>((resolve, reject) => {
    stream.write(request, (err: any) => {
      if (err === null || err === undefined) {
        resolve();
      } else {
        reject(err);
      }
    });
  }).catch((reason) => {
    console.error(reason);
    throw reason;
  });

  // await streamClosed;

  const pingRequest: SubscribeRequest = {
    ping: { id: 1 },
    // Required, but unused arguments
    accounts: {},
    accountsDataSlice: [],
    transactions: {},
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
    slots: {},
  };
  setInterval(async () => {
    await new Promise<void>((resolve, reject) => {
      stream.write(pingRequest, (err) => {
        if (err === null || err === undefined) {
          resolve();
        } else {
          reject(err);
        }
      });
    }).catch((reason) => {
      console.error(reason);
      throw reason;
    });
  }, PING_INTERVAL_MS);

  await streamClosed;
}

function parseCommandLineArgs() {
  return yargs(process.argv.slice(2))
    .options({
      endpoint: {
        alias: "e",
        default: "http://localhost:10000",
        describe: "gRPC endpoint",
        type: "string",
      },
      "x-token": {
        describe: "token for auth, can be used only with ssl",
        type: "string",
      },
      commitment: {
        describe: "commitment level",
        choices: ["processed", "confirmed", "finalized"],
      },
    })
    .command("ping", "single ping of the RPC server")
    .command("get-version", "get the server version")
    .command("get-latest-blockhash", "get the latest block hash")
    .command("get-block-height", "get the current block height")
    .command("get-slot", "get the current slot")
    .command(
      "is-blockhash-valid",
      "check the validity of a given block hash",
      (yargs: any) => {
        return yargs.options({
          blockhash: {
            type: "string",
            demandOption: true,
          },
        });
      }
    )
    .command("subscribe", "subscribe to events", (yargs: any) => {
      return yargs.options({
        accounts: {
          default: false,
          describe: "subscribe on accounts updates",
          type: "boolean",
        },
        "accounts-account": {
          default: [],
          describe: "filter by account pubkey",
          type: "array",
        },
        "accounts-owner": {
          default: [],
          describe: "filter by owner pubkey",
          type: "array",
        },
        "accounts-memcmp": {
          default: [],
          describe:
            "filter by offset and data, format: `offset,data in base58`",
          type: "array",
        },
        "accounts-datasize": {
          default: 0,
          describe: "filter by data size",
          type: "number",
        },
        "accounts-tokenaccountstate": {
          default: false,
          describe: "filter valid token accounts",
          type: "boolean",
        },
        "accounts-dataslice": {
          default: [],
          describe:
            "receive only part of updated data account, format: `offset,size`",
          type: "string",
        },
        slots: {
          default: false,
          describe: "subscribe on slots updates",
          type: "boolean",
        },
        "slots-filter-by-commitment": {
          default: false,
          describe: "filter slot messages by commitment",
          type: "boolean",
        },
        transactions: {
          default: false,
          describe: "subscribe on transactions updates",
          type: "boolean",
        },
        "transactions-vote": {
          description: "filter vote transactions",
          type: "boolean",
        },
        "transactions-failed": {
          description: "filter failed transactions",
          type: "boolean",
        },
        "transactions-signature": {
          description: "filter by transaction signature",
          type: "string",
        },
        "transactions-account-include": {
          default: [],
          description: "filter included account in transactions",
          type: "array",
        },
        "transactions-account-exclude": {
          default: [],
          description: "filter excluded account in transactions",
          type: "array",
        },
        "transactions-account-required": {
          default: [],
          description: "filter required account in transactions",
          type: "array",
        },
        "transactions-status": {
          default: false,
          describe: "subscribe on transactionsStatus updates",
          type: "boolean",
        },
        "transactions-status-vote": {
          description: "filter vote transactions",
          type: "boolean",
        },
        "transactions-status-failed": {
          description: "filter failed transactions",
          type: "boolean",
        },
        "transactions-status-signature": {
          description: "filter by transaction signature",
          type: "string",
        },
        "transactions-status-account-include": {
          default: [],
          description: "filter included account in transactions",
          type: "array",
        },
        "transactions-status-account-exclude": {
          default: [],
          description: "filter excluded account in transactions",
          type: "array",
        },
        "transactions-status-account-required": {
          default: [],
          description: "filter required account in transactions",
          type: "array",
        },
        entry: {
          default: false,
          description: "subscribe on entry updates",
          type: "boolean",
        },
        blocks: {
          default: false,
          description: "subscribe on block updates",
          type: "boolean",
        },
        "blocks-account-include": {
          default: [],
          description: "filter included account in transactions",
          type: "array",
        },
        "blocks-include-transactions": {
          default: false,
          description: "include transactions to block messsage",
          type: "boolean",
        },
        "blocks-include-accounts": {
          default: false,
          description: "include accounts to block message",
          type: "boolean",
        },
        "blocks-include-entries": {
          default: false,
          description: "include entries to block message",
          type: "boolean",
        },
        "blocks-meta": {
          default: false,
          description: "subscribe on block meta updates (without transactions)",
          type: "boolean",
        },
        ping: {
          default: undefined,
          description: "send ping request in subscribe",
          type: "number",
        },
      });
    })
    .demandCommand(1)
    .help().argv;
}

main();

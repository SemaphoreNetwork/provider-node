import Payments from "../artifacts/contracts/Payments.sol/Payments.json" with { type: "json" };
import TestERC20 from "../artifacts/contracts/TestERC20.sol/TestERC20.json" with { type: "json" };
import SemaphoreHSS from "../artifacts/contracts/SemaphoreHSS.sol/SemaphoreHSS.json" with { type: "json" };
import { Wallet, ContractFactory, JsonRpcProvider, Contract } from "ethers";
import { ChannelManager } from "./ChannelManager.ts";
import * as dotenv from "dotenv";
import fs from "fs";

dotenv.config();

// TODO: Move to tests dir.

async function deployContract(
  artifact: any,
  args: any[],
  signer: any
): Promise<Contract> {
  const factory = new ContractFactory(artifact.abi, artifact.bytecode, signer);
  const contract = await factory.deploy(...args);
  const dpTxReceipt = await contract.deploymentTransaction().wait();

  console.log(await contract.getAddress());
  console.log(dpTxReceipt);
  return new Contract(await contract.getAddress(), artifact.abi, signer);
}

async function main() {
  // Using Sepolia as the test chain.
  const chainId = 11155111;

  // Instantiate operator, subscriber, and provider wallets.
  const rpc = new JsonRpcProvider("https://rpc2.sepolia.org", chainId);
  const operator = Wallet.fromPhrase(process.env.MNEMONIC, rpc);
  const subscriber = Wallet.fromPhrase(process.env.SUBSCRIBER_A);
  const provider = Wallet.fromPhrase(process.env.PROVIDER_A);

  // Get TEST token contract. If there is no contract, deploy one.
  const TestERC20Contract = (TestERC20 as any).address
    ? new Contract((TestERC20 as any).address, TestERC20.abi, operator)
    : await deployContract(TestERC20, ["Test", "TEST"], operator);

  // Get Payments token contract. If there is no contract, deploy one.
  const PaymentsContract = (Payments as any).address
    ? new Contract((Payments as any).address, Payments.abi, operator)
    : await deployContract(Payments, [operator.address], operator);

  // Get SemaphoreHSS token contract. If there is no contract, deploy one.
  const SemaphoreHSSContract = (SemaphoreHSS as any).address
    ? new Contract((SemaphoreHSS as any).address, SemaphoreHSS.abi, operator)
    : await deployContract(SemaphoreHSS, [operator.address], operator);

  // TODO: Ensure provider is registered with HSS.
  // const res = await SemaphoreHSSContract.getProviderKey(0);
  // console.log(res);
  // TODO: Ensure subscriber is registered with HSS.

  // Make channel manager for our provider to use.
  const channelManager = new ChannelManager(
    process.env.MNEMONIC,
    {
      [chainId.toString()]: {
        providers: ["https://rpc2.sepolia.org"],
        assets: [await TestERC20Contract.getAddress()],
        contracts: {
          Payments: {
            abi: Payments.abi,
            address: await PaymentsContract.getAddress(),
          },
          SemaphoreHSS: {
            abi: SemaphoreHSS.abi,
            address: await SemaphoreHSSContract.getAddress(),
          },
        },
      },
    },
    10 * 60
  );

  // Have the subscriber sign off on a payment.
  let nonce: number = 0;
  let nonceVerified = false;
  while (!nonceVerified) {
    const res: boolean = await PaymentsContract.isNonceUsed(
      await subscriber.getAddress(),
      nonce
    );
    nonceVerified = !res;
  }
  console.log("Got nonce:", nonce);
  //
  // const types = ["uint256", "address", "uint256", "bytes"];
  // const values = [];
  // const sig = subscriber.signMessage();
}

main();

export {};

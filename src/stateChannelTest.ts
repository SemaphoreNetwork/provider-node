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
  const subscriber = Wallet.fromPhrase(process.env.SUBSCRIBER_A, rpc);
  const provider = Wallet.fromPhrase(process.env.PROVIDER_A, rpc);

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

  // Mint tokens for subscriber.
  const amount = 1000;
  {
    // Get the current amount.
    let currentAmount = 0;
    {
      const res = await TestERC20Contract.balanceOf(subscriber.address);
      currentAmount = parseInt(res.toString());
      console.log("Subscriber tokens:", currentAmount);
    }
    // If the subscriber has less than the target amount, mint tokens.
    if (currentAmount < amount) {
      const res = await TestERC20Contract.mint(
        subscriber.address,
        amount - currentAmount
      );
      const receipt = await res.wait();
      console.log("Mint res:", res);

      // Check new amount to be confirm.
      {
        const res = await TestERC20Contract.balanceOf(subscriber.address);
        currentAmount = parseInt(res.toString());
        console.log("Subscriber tokens after mint:", currentAmount);
      }
    }
  }

  // Send ETH to subscriber if needed.
  {
    let currentAmount = BigInt("0");
    const minimumAmount = BigInt("10000000000000000"); // 0.01 ETH
    // Check current balance.
    {
      const res = await rpc.getBalance(subscriber);
      currentAmount = BigInt(res.toString());
      console.log("Subscriber ETH:", currentAmount.toString());
    }
    // Add more ETH if needed.
    if (currentAmount < minimumAmount) {
      const res = await operator.sendTransaction({
        to: subscriber.address,
        value: BigInt("50000000000000000") - BigInt(currentAmount.toString()), // 0.05 ETH
      });
      const receipt = await res.wait();
      console.log("Fund ETH receipt:", receipt);

      // Check new balance.
      {
        const res = await rpc.getBalance(subscriber);
        currentAmount = BigInt(res.toString());
        console.log("Subscriber ETH:", currentAmount.toString());
      }
    }
  }

  // Ensure the token is permissioned correctly on the Payments contract.
  {
    const address = await TestERC20Contract.getAddress();
    const res = await PaymentsContract.isAssetAllowed(address);
    if (!res) {
      console.log("Token is not permitted yet on Payments contract.");
      const res = await PaymentsContract.allowAsset(address);
      const receipt = await res.wait();
      console.log("allowAsset receipt:", receipt);
    }
  }

  // Subscriber deposits tokens into the Payments contract.
  {
    console.log("Depositing tokens:", amount);
    // For some reason ethers' .connect() fn not working.
    const PaymentsContractSubscriber = new Contract(
      (Payments as any).address,
      Payments.abi,
      subscriber
    );
    const res = await PaymentsContractSubscriber.deposit(
      await TestERC20Contract.getAddress(),
      amount
    );
    const receipt = await res.wait();
    console.log("Deposit receipt:", receipt);
  }

  // TODO: Replace with ID.
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

  // Have the subscriber sign off on a payment.
  const types = ["uint256", "address", "uint256", "bytes"];
  const values = [nonce, await TestERC20Contract.getAddress(), 100];
  // const sig = subscriber.signMessage();
}

main();

export {};

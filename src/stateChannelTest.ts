import Payments from "../artifacts/contracts/Payments.sol/Payments.json" with { type: "json" };
import TestERC20 from "../artifacts/contracts/TestERC20.sol/TestERC20.json" with { type: "json" };
import SemaphoreHSS from "../artifacts/contracts/SemaphoreHSS.sol/SemaphoreHSS.json" with { type: "json" };
import {
  Wallet,
  ContractFactory,
  JsonRpcProvider,
  Contract,
  ErrorFragment,
  AbiCoder,
  keccak256,
} from "ethers";
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
  console.log("Operator:", operator.address);
  console.log("Subscriber:", subscriber.address);
  console.log("Provider:", provider.address);

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
  // const channelManager = new ChannelManager(
  //   process.env.MNEMONIC,
  //   {
  //     [chainId.toString()]: {
  //       providers: ["https://rpc2.sepolia.org"],
  //       assets: [await TestERC20Contract.getAddress()],
  //       contracts: {
  //         Payments: {
  //           abi: Payments.abi,
  //           address: await PaymentsContract.getAddress(),
  //         },
  //         SemaphoreHSS: {
  //           abi: SemaphoreHSS.abi,
  //           address: await SemaphoreHSSContract.getAddress(),
  //         },
  //       },
  //     },
  //   },
  //   10 * 60
  // );

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
      console.log("Mint tx:", receipt.hash);

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
      const res = await rpc.getBalance(subscriber.address);
      currentAmount = BigInt(res.toString());
      console.log("Subscriber ETH:", currentAmount.toString());
    }
    // Add more ETH if needed.
    if (currentAmount < minimumAmount) {
      console.log("Funding subscriber some ETH...");
      const res = await operator.sendTransaction({
        to: subscriber.address,
        value: BigInt("50000000000000000") - BigInt(currentAmount.toString()), // 0.05 ETH
      });
      const receipt = await res.wait();
      console.log("Fund ETH tx:", receipt.hash);

      // Check new balance.
      {
        const res = await rpc.getBalance(subscriber);
        currentAmount = BigInt(res.toString());
        console.log("Subscriber ETH:", currentAmount.toString());
      }
    }
  }

  // Send ETH to provider if needed.
  {
    let currentAmount = BigInt("0");
    const minimumAmount = BigInt("5000000000000000"); // 0.005 ETH
    // Check current balance.
    {
      const res = await rpc.getBalance(provider.address);
      currentAmount = BigInt(res.toString());
      console.log("Provider ETH:", currentAmount.toString());
    }
    {
      const res = await rpc.getBalance(operator.address);
      console.log("Operator ETH:", res);
    }
    // Add more ETH if needed.
    if (currentAmount < minimumAmount) {
      console.log("Funding provider some ETH...");
      const res = await operator.sendTransaction({
        to: provider.address,
        value: BigInt("10000000000000000") - BigInt(currentAmount.toString()), // 0.01 ETH
      });
      const receipt = await res.wait();
      console.log("Fund ETH tx:", receipt.hash);

      // Check new balance.
      {
        const res = await rpc.getBalance(provider);
        currentAmount = BigInt(res.toString());
        console.log("Provider ETH:", currentAmount.toString());
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
      console.log("allowAsset tx:", receipt.hash);
    } else {
      console.log("Token is permitted on Payments contract.");
    }
  }

  // Subscriber deposits tokens into the Payments contract.
  {
    try {
      // For some reason ethers' .connect() fn not working.
      const PaymentsContractSubscriber = new Contract(
        await PaymentsContract.getAddress(),
        Payments.abi,
        subscriber
      );
      // Get current balance.
      let currentBalance = BigInt("0");
      {
        const res = await PaymentsContractSubscriber.checkBalance(
          await TestERC20Contract.getAddress()
        );
        currentBalance = BigInt(res.toString());
      }
      console.log(
        "Subscriber current Payments contract balance:",
        currentBalance
      );
      if (currentBalance < BigInt(amount.toString())) {
        // Approve spending for Payments contract.
        {
          const TestERC20ContractSubscriber = new Contract(
            await TestERC20Contract.getAddress(),
            TestERC20.abi,
            subscriber
          );
          // Get current allowance.
          let currentAllowance = BigInt("0");
          {
            const res = await TestERC20ContractSubscriber.allowance(
              subscriber.address,
              await PaymentsContract.getAddress()
            );
            currentAllowance = BigInt(res.toString());
          }
          console.log(
            "Payments contract allowance:",
            currentAllowance.toString()
          );
          // If insufficient, approve more token spending.
          if (currentAllowance < BigInt(amount.toString())) {
            const res = await TestERC20ContractSubscriber.approve(
              await PaymentsContract.getAddress(),
              amount
            );
            const receipt = await res.wait();
            console.log("Approve tx:", receipt.hash);
            // Double check allowance is correct.
            {
              const res = await TestERC20ContractSubscriber.allowance(
                subscriber.address,
                await PaymentsContract.getAddress()
              );
              currentAllowance = BigInt(res.toString());
            }
            console.log(
              "Payments contract allowance:",
              currentAllowance.toString()
            );
          }
        }
        // Deposit tokens.
        console.log("Depositing tokens:", amount);
        const res = await PaymentsContractSubscriber.deposit(
          await TestERC20Contract.getAddress(),
          amount
        );
        const receipt = await res.wait();
        console.log("Deposit tx:", receipt.hash);
      }
    } catch (e) {
      const selector = e.data.substring(0, 10);
      const fragment = PaymentsContract.interface.fragments.find(
        (fragment) => (fragment as ErrorFragment).selector === selector
      );
      if (fragment) {
        const revert = {
          name: (fragment as ErrorFragment).name,
          signature: fragment.format(),
          args: PaymentsContract.interface.decodeErrorResult(
            fragment as ErrorFragment,
            e.data
          ),
        };
        console.log(revert);
      }
    }
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
  const types = ["address", "uint256", "address", "uint256"];
  const values = [
    provider.address,
    nonce,
    await TestERC20Contract.getAddress(),
    100,
  ];
  const encoded = AbiCoder.defaultAbiCoder().encode(types, values);
  const hash = keccak256(encoded);
  const sig = await subscriber.signMessage(hash);
  console.log("Signed:", values);
  console.log("Signature:", sig);

  // Submit claim using provider.
  {
    const PaymentsContractProvider = new Contract(
      await PaymentsContract.getAddress(),
      Payments.abi,
      provider
    );
    try {
      const res = await PaymentsContractProvider.claim(
        nonce,
        await TestERC20Contract.getAddress(),
        100,
        sig
      );
      const receipt = res.wait();
      console.log("Claim receipt:", receipt);
    } catch (e) {
      const selector = e.data.substring(0, 10);
      const fragment = PaymentsContract.interface.fragments.find(
        (fragment) => (fragment as ErrorFragment).selector === selector
      );
      if (fragment) {
        const revert = {
          name: (fragment as ErrorFragment).name,
          signature: fragment.format(),
          args: PaymentsContract.interface.decodeErrorResult(
            fragment as ErrorFragment,
            e.data
          ),
        };
        console.log(revert);
      }
    }
  }
}

main();

export {};

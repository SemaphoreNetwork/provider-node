import Payments from "../artifacts/contracts/Payments.sol/Payments.json" with { type: "json" };
import TestERC20 from "../artifacts/contracts/TestERC20.sol/TestERC20.json" with { type: "json" };
import SemaphoreHSS from "../artifacts/contracts/SemaphoreHSS.sol/SemaphoreHSS.json" with { type: "json" };
import { Wallet, ContractFactory } from "ethers";
import { ChannelManager } from "./ChannelManager";
import * as dotenv from "dotenv";

dotenv.config();

// TODO: Move to tests dir.

async function main() {
  // Using Sepolia as the test chain.
  const chainId = 111555111;

  const sugarDaddy = Wallet.fromPhrase(process.env.MNEMONIC);

  // Get TEST token contract. If there is no contract, deploy one.
  const factory = new ContractFactory(TestERC20.abi, TestERC20.bytecode);
  const deployArgs = ["Test", "TEST"];
  factory.connect(sugarDaddy);
  const contract = await factory.deploy(deployArgs);
  const dpTx = await contract.deploymentTransaction().wait();

  console.log(contract.getAddress());
  console.log(dpTx);
  console.log(contract.deploymentTransaction())
}

main();

export {};

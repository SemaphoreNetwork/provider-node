import Payments from "../artifacts/contracts/Payments.sol/Payments.json" with { type: "json" };
import TestERC20 from "../artifacts/contracts/TestERC20.sol/TestERC20.json" with { type: "json" };
import SemaphoreHSS from "../artifacts/contracts/SemaphoreHSS.sol/SemaphoreHSS.json" with { type: "json" };
import { Wallet, ContractFactory } from "ethers";

// TODO: Move to tests dir.

async function main() {
  // Using Sepolia as the test chain.
  const chainId = 111555111;

  // const sugarDaddy = new Wallet(process.env.MNEMONIC);

  // // Get TEST token contract. If there is no contract, deploy one.
  // const factory = new ContractFactory(TestERC20.abi, TestERC20.bytecode);
  // const deployArgs = ["Test", "TEST"];
  // const contract = await factory.deploy(deployArgs);

  // console.log(contract.address);
  // console.log(contract.deployTransaction);
  console.log("hello world");
}

main();

export {};

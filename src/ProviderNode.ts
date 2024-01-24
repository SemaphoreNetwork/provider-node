import {
  Wallet,
  JsonRpcProvider,
  Interface,
  TransactionResponse,
  HDNodeWallet,
  ErrorFragment,
} from "ethers";
import { Channel, ChannelCache } from "./ChannelCache";

type ContractInfo = {
  abi: any[];
  address: string;
};

type ChannelManagerConfig = {
  chains: {
    [chainId: string]: {
      assets: string[];
      providers: InstanceType<typeof JsonRpcProvider>[];
      contracts: {
        Payments: ContractInfo;
        SemaphoreHSS: ContractInfo;
      };
    };
  };
  channels: {
    expiryTolerance: number;
  };
};

export class ProviderNode {
  private readonly wallet: HDNodeWallet;
  private readonly cache: ChannelCache;
  private readonly config: ChannelManagerConfig;
  private isRetired: boolean = false;

  constructor(
    mnemonic: string,
    chains: {
      [chainId: string]: {
        providers: string[];
        assets: string[];
        contracts: {
          Payments: ContractInfo;
          SemaphoreHSS: ContractInfo;
        };
      };
    },
    expiryTolerance?: number
  ) {
    const config: ChannelManagerConfig = {
      chains: {},
      channels: {
        expiryTolerance: expiryTolerance ?? 60 * 60 * 48, // Default is 2 days minimum.
      },
    };
    for (const chain of Object.keys(chains)) {
      const urls = chains[chain].providers;
      const providers: InstanceType<typeof JsonRpcProvider>[] = [];
      for (const url of urls) {
        providers.push(new JsonRpcProvider(url, parseInt(chain)));
      }
      config.chains[chain] = {
        providers,
        assets: chains[chain].assets,
        contracts: chains[chain].contracts,
      };
    }

    this.config = config;
    this.wallet = Wallet.fromPhrase(mnemonic);
  }

  public async openChannel(
    chainId: string,
    subscriber: string,
    asset: string,
    amount: string,
    expiry: number,
    signature?: string
  ): Promise<string> {
    // Ensure not retired.
    this.assertNotRetired();

    // Make sure chain is supported.
    if (!this.isChainSupported(chainId)) {
      throw new Error("Chain is not supported.");
    }
    // Make sure asset is supported.
    if (!this.isAssetSupported(chainId, asset)) {
      throw new Error("Asset is not supported.");
    }

    // Check to ensure the expiry is valid.
    if (
      expiry - Math.floor(new Date().getTime() / 1000) <
      this.config.channels.expiryTolerance
    ) {
      throw new Error("Time til expiry is insufficient.");
    }

    // TODO: Check if subscriber address is a valid subscriber.
    // const contract = this.config.chains[chainId].contracts.SemaphoreHSS;
    // this.sendTransaction(
    //   chainId,
    //   contract,
    //   "isSubscriber",
    //   [subscriber],
    //   false
    // );

    // TODO: Verify that the signature works.

    // Init payment channel.
    const id = await this.generateId(chainId, subscriber);
    this.cache.upsertChannel({
      id,
      chainId,
      sender: subscriber,
      asset,
      amount,
      expiry,
      signature,
    });

    // TODO:
    // Subscriber may already have an open channel on this chain, and cannot have more than one
    // open at a time. If they do have one open, we should close that one and open another.

    return id;
  }

  public async redeemChannels(withMinTime): Promise<number> {
    const openChannels = await this.cache.getOpenChannels();
    const closingChannels = [];
    for (const id of openChannels) {
      const channel = await this.cache.getChannel(id);
      // Check to see if we want to close out this channel based on how long it's lived.
      if (
        Math.floor(new Date().getTime() / 1000) - channel.state.timestamp >
        withMinTime
      ) {
        closingChannels.push(channel);
      }
    }
    await this.closeChannels(closingChannels);
    return closingChannels.length;
  }

  private async closeChannels(channels: Channel[]) {
    // TODO: Replace with batch close.
    for (const channel of channels) {
      // Attempt to redeem the channel on-chain.
      let res = await this.sendTransaction<any>(
        channel.chainId,
        this.config.chains[channel.chainId].contracts.Payments,
        "claim",
        [
          channel.id,
          channel.asset,
          channel.state.amount,
          channel.state.expiry,
          channel.state.signature,
        ],
        false
      );
      if (!res) {
        console.log("Unable to close channel with ID:", channel.id);
        continue;
      }
      // Close out the channel in the cache.
      res = this.cache.closeChannel(channel.id);
    }
  }

  private isChainSupported(chainId: string): boolean {
    for (const chain in Object.keys(this.config.chains)) {
      if (chain === chainId) {
        return true;
      }
    }
    return false;
  }

  private isAssetSupported(chainId: string, asset: string): boolean {
    for (const assetAddress in this.config.chains[chainId].assets) {
      if (asset === assetAddress) {
        return true;
      }
    }
    return false;
  }

  // Generate a random ID for a state channel session.
  private async generateId(
    chainId: string,
    subscriber: string
  ): Promise<string> {
    const id = await this.sendTransaction<string>(
      chainId,
      this.config.chains[chainId].contracts.Payments,
      "getRandomId",
      [subscriber, this.wallet.address, Math.floor(Math.random() * 100000 + 1)],
      true
    );
    return id;
  }

  // Will iterate through all available providers for a given chain until one works.
  private async sendTransaction<T>(
    chainId: string,
    contract: ContractInfo,
    functionName: string,
    args: any[],
    read?: boolean
  ): Promise<T | undefined> {
    // Derive encoded calldata.
    const iface = new Interface(contract.abi as any[]);
    const data = iface.encodeFunctionData(functionName, args);
    // Format transaction.
    const tx = {
      to: contract.address,
      data,
      chainId: +chainId,
    };

    const errors: any[] = [];
    for (const provider of this.config[chainId].providers) {
      try {
        if (read) {
          const res: TransactionResponse = await (
            provider as typeof JsonRpcProvider
          ).call(tx);
          return res as T;
        } else {
          // Connect the wallet to the target RPC provider.
          this.wallet.connect(provider);
          // Send transaction.
          const res = await this.wallet.sendTransaction(tx);
          return (await res.wait()) as T;
        }
      } catch (e) {
        let error: any;
        if (e.data) {
          const selector = e.data.substring(0, 10);
          const fragment = iface.fragments.find(
            (fragment) => (fragment as ErrorFragment).selector === selector
          );
          if (fragment) {
            error = {
              name: (fragment as ErrorFragment).name,
              signature: fragment.format(),
              args: iface.decodeErrorResult(fragment as ErrorFragment, e.data),
            };
          }
        }

        errors.push(error ? error : e);
      }
    }

    // TODO: Should we store these errors anywhere?
    console.log("Error:", functionName, args, errors[0]);
    return undefined;
  }
}

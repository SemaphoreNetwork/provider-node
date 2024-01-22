import {
  Wallet,
  JsonRpcProvider,
  Interface,
  TransactionResponse,
  HDNodeWallet,
} from "ethers";
import { PaymentChannel } from "./PaymentChannel.ts";

type Contract = {
  abi: any[];
  address: string;
};

type Contracts = {
  Payments: Contract;
  SemaphoreHSS: Contract;
};

type ChannelManagerConfig = {
  chains: {
    [chainId: string]: {
      assets: string[];
      providers: InstanceType<typeof JsonRpcProvider>[];
      contracts: Contracts;
    };
  };
  channels: {
    ttl: number;
  };
};

export class ChannelManager {
  private wallet: HDNodeWallet;
  private config: ChannelManagerConfig;

  // TODO: This should move to a database model instead of being ephemeral state.
  private channels: {
    [subscriber: string]: {
      open?: PaymentChannel;
      closed: PaymentChannel[];
    };
  };

  private isRetired: boolean = false;

  constructor(
    mnemonic: string,
    chains: {
      [chainId: string]: {
        providers: string[];
        assets: string[];
        contracts: Contracts;
      };
    },
    ttl: number
  ) {
    const config: ChannelManagerConfig = {
      chains: {},
      channels: { ttl },
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

  public openChannel(
    chainId: string,
    subscriber: string,
    nonce: number,
    asset: string,
    amount?: number,
    signature?: string
  ): string {
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

    // Check if subscriber address is a valid subscriber.
    const contract = this.config.chains[chainId].contracts.SemaphoreHSS;
    this.sendTransaction(
      chainId,
      contract,
      "isSubscriber",
      [subscriber],
      false
    );

    // Init payment channel.
    const channel = new PaymentChannel(
      chainId,
      subscriber,
      this.wallet.address,
      nonce,
      asset,
      this.config.channels.ttl
    );

    // Subscriber may already have an open channel, and cannot have more than one open at a time.
    // If they do have one open, we should close that one and open another.
    if (this.channels[subscriber].open) {
      this.channels[subscriber].closed.push(this.channels[subscriber].open!);
    }
    this.channels[subscriber].open = channel;

    // If there's an initial amount and signature attached, apply that.
    if (amount && signature) {
      this.updateChannel(subscriber, amount, signature);
    }

    return channel.session.id;
  }

  public updateChannel(subscriber: string, amount: number, signature: string) {
    // Ensure not retired.
    this.assertNotRetired();

    const channel = this.channels[subscriber].open;
    if (!channel) {
      throw new Error("Subscriber does not have an open channel.");
    }

    // Amount should only increase.
    if (amount < channel.session.state.amount) {
      throw new Error("New amount is less than current amount.");
    }

    // TODO: Verify signature works by doing a dry run on `claim()`.

    channel.update(amount, signature);
  }

  public closeChannel(subscriber: string) {
    const channel = this.channels[subscriber].open;
    if (!channel) {
      throw new Error("Subscriber does not have an open channel.");
    }

    if (channel.isOpen()) {
      channel.close();
      this.channels[subscriber].closed.push(channel);
      this.channels[subscriber].open = undefined;
    }
  }

  public groomChannels(closeAll?: boolean) {
    for (const subscriber of Object.keys(this.channels)) {
      const channels = this.channels[subscriber];
      // Calling isOpen will check expiry as well.
      if (closeAll || (channels.open && !channels.open.isOpen())) {
        this.closeChannel(subscriber);
      }
    }
  }

  public async submitClaims() {
    // TODO: Should we call groomChannels here or leave that up to user?
    const batches: { [chainId: string]: PaymentChannel[] } = {};
    for (const subscriber of Object.keys(this.channels)) {
      const closedChannels = this.channels[subscriber].closed;
      while (closedChannels.length > 0) {
        const channel = closedChannels.pop();
        batches[channel!.session.chainId].push(channel!);
      }
    }

    for (const chain of Object.keys(batches)) {
      const errors: any[] = [];

      // TODO: Convert to a batchClaim() call once that is implemented.
      const batch = batches[chain];
      for (const channel of batch) {
        const contract = this.config.chains[chain].contracts.Payments;
        const session = channel.session;

        // Args for `claim()` call.
        this.sendTransaction(
          chain,
          contract,
          "claim",
          [
            session.nonce,
            session.asset,
            session.state.amount,
            session.state.signature,
          ],
          false
        );
      }
    }
  }

  public isChainSupported(chainId: string): boolean {
    for (const chain in Object.keys(this.config.chains)) {
      if (chain === chainId) {
        return true;
      }
    }
    return false;
  }

  public isAssetSupported(chainId: string, asset: string): boolean {
    for (const assetAddress in this.config.chains[chainId].assets) {
      if (asset === assetAddress) {
        return true;
      }
    }
    return false;
  }

  public retire() {
    this.isRetired = true;
  }

  private assertNotRetired() {
    if (this.isRetired) {
      throw new Error("Provider is no longer accepting incoming connections.");
    }
  }

  // Will iterate through all available providers for a given chain until one works.
  private async sendTransaction(
    chainId: string,
    contract: Contract,
    functionName: string,
    args: any[],
    read?: boolean
  ): Promise<any> {
    // Derive encoded calldata.
    const data = new Interface(contract.abi as string[]).encodeFunctionData(
      functionName,
      args
    );
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
          return await res.wait();
        } else {
          // Connect the wallet to the target RPC provider.
          this.wallet.connect(provider);
          // Send transaction.
          const res = await this.wallet.sendTransaction(tx);
          return await res.wait();
        }
      } catch (e) {
        errors.push(e);
      }
    }
  }
}

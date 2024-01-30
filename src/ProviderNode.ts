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

  /**
   * Open a new state channel session for a given subscriber on a given chain. Payment will be
   * delivered in the specified asset, and micro-payments are conducted by increasing amount,
   * expiry, and updating the signature.
   *
   * @param id - The unique random identifier for this state channel session. Should have been
   * generated before producing the initial signature on the subscriber side.
   * @param chainId - The chain that the state channel redemption will take place.
   * @param subscriber - The subscriber address.
   * @param asset - The asset in which payment is conducted.
   * @param amount - The initial amount for this channel.
   * @param expiry - The on-chain expiry of the channel.
   * @param signature - The signature on (id, provider, asset, amount, expiry) digest.
   * @returns The generated ID string of the new channel.
   */
  public async openChannel({
    id,
    chainId,
    subscriber,
    asset,
    amount,
    expiry,
    signature,
  }: {
    id: string;
    chainId: string;
    subscriber: string;
    asset: string;
    amount: string;
    expiry: number;
    signature?: string;
  }): Promise<string> {
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
    this.assertValidExpiry(expiry);

    // Check if subscriber address is a valid subscriber.
    if (!this.checkIfSubscriber(chainId, subscriber)) {
      throw new Error("Not a valid subscriber address.");
    }

    // Verify that the signature works.
    await this.assertValidSignature({
      id,
      chainId,
      asset,
      amount,
      expiry,
      signature,
    });

    // Init payment channel.
    this.cache.insertChannel({
      id,
      chainId,
      sender: subscriber,
      asset,
      amount,
      expiry,
      signature,
    });

    // TODO:
    // Subscriber may already have an open channel on this chain, and may be unideal to have more
    // than one open at a time. If they do have one open, we should close that one and open another.

    return id;
  }

  /**
   * Updates the state of a channel with given ID to increase delivered amount.
   *
   * @param id - The ID string of the updated channel.
   * @param amount - The new amount delivered. Should be greater than the previous amount.
   * @param expiry - The new expiry for the state channel. Should be at minimum a tolerated
   * amount of time from the current time (e.g. 2 days).
   * @param signature - The signature of the subscriber on (id, provider, asset, amount,
   * expiry) digest.
   */
  public async updateChannel({
    id,
    amount,
    expiry,
    signature,
  }: {
    id: string;
    amount: string;
    expiry: number;
    signature?: string;
  }) {
    // Ensure not retired.
    this.assertNotRetired();

    // Check to ensure the expiry is valid.
    this.assertValidExpiry(expiry);

    // Get the current channel.
    const channel = await this.cache.getChannel(id);

    // Verify that the signature works.
    await this.assertValidSignature({
      id,
      chainId: channel.chainId,
      asset: channel.asset,
      amount,
      expiry,
      signature,
    });

    // Finally, update the channel's current state.
    await this.cache.updateChannel({
      id,
      amount,
      expiry,
      signature,
    });
  }

  /**
   * Submit `claim()` calls for all channels with a specified minimum amount of time since
   * last updated.
   * @param withMinTime - Minimum time in seconds for a channel to exist without updates to
   * qualify for redemption.
   * @returns Number of channels redeemed.
   */
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

  /**
   * Retire this provider node instance, preventing any new incoming channels.
   */
  public retire() {
    this.isRetired = true;
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
    }
    // Close out the channel in the cache.
    const success = this.cache.closeChannels(
      channels.map((channel) => channel.id)
    );
  }

  /** Generate a random ID for a state channel session.
   * @param chainId - ID of the chain to call `getRandomId` on.
   * @param subscriber - The subscriber address
   */
  public async generateId(
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

  private assertNotRetired() {
    if (this.isRetired) {
      throw new Error("Provider is no longer accepting incoming connections.");
    }
  }

  private assertValidExpiry(expiry: number) {
    // Check to ensure the expiry is valid.
    if (
      expiry - Math.floor(new Date().getTime() / 1000) <
      this.config.channels.expiryTolerance
    ) {
      throw new Error("Time til expiry is insufficient.");
    }
  }

  private async checkIfSubscriber(
    chainId: string,
    subscriber: string
  ): Promise<boolean> {
    const contract = this.config.chains[chainId].contracts.SemaphoreHSS;
    const result = await this.sendTransaction<boolean>(
      chainId,
      contract,
      "isSubscriber",
      [subscriber],
      false
    );
    return result;
  }

  private async assertValidSignature({
    id,
    chainId,
    asset,
    amount,
    expiry,
    signature,
  }: {
    id: string;
    chainId: string;
    asset: string;
    amount: string;
    expiry: number;
    signature: string;
  }) {
    const success = await this.estimateGas(
      chainId,
      this.config.chains[chainId].contracts.Payments,
      "claim",
      [id, asset, amount, expiry, signature]
    );
    if (!success) {
      throw new Error("Invalid signature.");
    }
  }

  private async estimateGas(
    chainId: string,
    contract: ContractInfo,
    functionName: string,
    args: any[]
  ): Promise<boolean> {
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
        // Connect the wallet to the target RPC provider.
        this.wallet.connect(provider);
        // Estimate gas.
        const res = await this.wallet.estimateGas(tx);
        return true;
      } catch (e) {
        errors.push(this.parseOnChainError(iface, e));
      }
    }
    return false;
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
        errors.push(this.parseOnChainError(iface, e));
      }
    }

    // TODO: Should we store these errors anywhere?
    console.log("Error:", functionName, args, errors[0]);
    return undefined;
  }

  private parseOnChainError(iface: Interface, e: any): any {
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
    return error ?? e;
  }
}

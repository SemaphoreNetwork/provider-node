import Redis from "ioredis";

// Static, fixed information regarding a given channel session.
export type ChannelHeader = {
  // Channel ID.
  id: string;
  // Chain where redemptions should occur.
  chainId: string;
  // The subscriber, sender of funds.
  sender: string;
  // The provider, receiver of funds.
  receiver: string;
  // The asset being delivered.
  asset: string;
};

// The last available state of a given channel session.
export type ChannelState = {
  // Timestamp of last update (in seconds).
  timestamp: number;
  // The number of updates that have happened so far for this channel.
  iteration: number;
  // The amount of tokens pledged in latest update.
  amount: string;
  // The latest signed expiry time (in seconds).
  expiry: number;
  // The latest signature.
  signature: string;
};

// TODO: Should we record previous states for any reason?
// The stored object, containing both the static header and the active state.
export type Channel = ChannelHeader & {
  state: ChannelState;
};

// List of channel IDs. Used in retrieving open and closed channels.
export type ChannelList = Array<string>;

// Params for constructing the cache.
export type CacheParams = {
  receiver: string;
  host: string;
  port: number;
  mock: boolean;
};

/**
 * Redis Store Details:
 * Channels:
 *   key: $id | value: JSON.stringify(Channel);
 *
 *
 * Channel Status:
 *   key: $id | value: JSON.stringify(ChannelStatus);
 */
export class ChannelCache {
  private readonly prefix = "channels";
  private readonly data!: Redis;
  private readonly receiver: string;

  constructor({ host, port, mock, receiver }: CacheParams) {
    this.receiver = receiver;
    if (mock) {
      const IoRedisMock = require("ioredis-mock");
      this.data = new IoRedisMock();
    } else {
      this.data = new Redis({
        host,
        port,
        connectTimeout: 17000,
        maxRetriesPerRequest: 4,
        retryStrategy: (times) => Math.min(times * 30, 1000),
      });
    }
  }

  /**
   * Retrieve channel data for a given channel ID.
   * @param id - The ID of the channel we are retrieving.
   * @returns Channel data if exists, undefined otherwise.
   */
  public async getChannel(id: string): Promise<Channel | undefined> {
    const res = await this.data.hget(`${this.prefix}:channel`, id);
    return res ? (JSON.parse(res) as Channel) : undefined;
  }

  /**
   * Retrieve all open channels.
   * @returns List of all currently open channels.
   */
  public async getOpenChannels(): Promise<ChannelList> {
    const res = await this.data.hget(`${this.prefix}:open`);
    return res ? (JSON.parse(res) as ChannelList) : [];
  }

  /**
   * Retrieve all closed channels.
   * @returns List of all currently closed channels.
   */
  public async getClosedChannels(): Promise<ChannelList> {
    const res = await this.data.hget(`${this.prefix}:closed`);
    return res ? (JSON.parse(res) as ChannelList) : [];
  }

  /**
   * Close a channel with given ID.
   * @param id - The ID of the channel we are closing.
   * @returns true if channel was closed, false if doesn't exist.
   */
  public async closeChannel(id: string): Promise<boolean> {
    // Remove target id from open channel list and commit.
    let res = await this.updateChannelList("open", id, true);
    if (!res) {
      return false;
    }

    // Add this ID into the closed channels list and commit.
    res = await this.updateChannelList("closed", id, false);
    if (!res) {
      return false;
    }
    return true;
  }

  /**
   * Creates or updates an existing channel entry for the given channel ID.
   *
   * @param data.id - The ID of channel.
   * @param data.chainId - The ID of the chain where redemptions will take place.
   * @param data.asset - The token asset being transferred.
   * @param data.amount - The latest amount of tokens being secured in the channel.
   * @param data.expiry - The on-chain expiry of the channel (can be updated).
   * @param data.signature - The sender's signature on digest (id, provider, asset, amount, expiry).
   *
   * @returns 0 if updated, 1 if created.
   */
  public async upsertChannel({
    id,
    chainId,
    sender,
    asset,
    amount,
    expiry,
    signature,
  }: {
    id: string;
    chainId: string;
    sender: string;
    asset: string;
    amount: string;
    expiry: number;
    signature: string;
  }): Promise<number> {
    let channel: Channel;
    // If channel entry exists, add to it. Otherwise, we'll create a new entry.
    channel = await this.getChannel(id);

    const timestamp = Math.floor(new Date().getTime() / 1000);
    if (!channel) {
      // Create a new channel if no entry exists.
      channel = {
        id,
        chainId,
        sender,
        receiver: this.receiver,
        asset,
        state: {
          timestamp,
          iteration: 1,
          amount,
          expiry,
          signature,
        },
      };
    } else {
      // Update the channel entry if it already exists.
      channel = {
        ...channel,
        state: {
          timestamp,
          // Increasing iterations by 1.
          iteration: channel.state.iteration + 1,
          amount,
          expiry,
          signature,
        },
      };
    }

    // Record the channel entry.
    let res = await this.data.hset(
      `${this.prefix}:channel`,
      id,
      JSON.stringify(channel)
    );
    // Update open channels list.
    res = await this.updateChannelList("open", id, false);

    // TODO: Check responses?

    return Number(res >= 1);
  }

  private async updateChannelList(
    which: "open" | "closed",
    id: string,
    remove: boolean
  ): Promise<boolean> {
    // Get current list of open channels.
    let res = await this.data.hget(`${this.prefix}:${which}`);
    if (!res) {
      return false;
    }
    const channelList = JSON.parse(res) as ChannelList;
    // Find the target channel index. If this is an insert operation, we want to make sure
    // it doesn't already exist.
    const targetChannelIndex = channelList.findIndex((value) => value === id);

    if (remove) {
      // Make sure the entry already exists.
      if (targetChannelIndex === -1) {
        return false;
      }
      // Remove target value from array.
      channelList.splice(targetChannelIndex, 1);
    } else {
      // Make sure the entry does not exist.
      if (targetChannelIndex !== -1) {
        return false;
      }
      // Insert target value into array.
      channelList.push(id);
    }
    // Commit the new change.
    res = await this.data.hset(
      `${this.prefix}:${which}`,
      JSON.stringify(channelList)
    );
  }

  /**
   * Flushes the entire cache.
   *
   * @returns string "OK"
   */
  private async clear(): Promise<"OK"> {
    return await this.data.flushall();
  }
}

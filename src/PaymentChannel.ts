export enum Status {
  OPEN = "open",
  CLOSED = "closed",
}

export type State = {
  iteration: number;
  amount: number;
  expiry: number;
  signature?: string;
  status: Status;
};

export type Session = {
  id: string;
  chainId: string;
  sender: string;
  receiver: string;
  nonce: number;
  asset: string;
  state: State;
};

export class PaymentChannel {
  // 10 minutes is the minimum expiry.
  public static readonly MIN_TTL: number = 60 * 10;
  // Period after which this channel will be considered expired.
  private readonly TTL: number;

  private _session: Session;
  public get session(): Session {
    return { ...this._session, state: { ...this._session.state } };
  }

  /**
   * @param chainId - EVM chain where redemptions (claims) will be delivered.
   * @param sender - Ethereum address of the subscriber.
   * @param receiver - Ethereum address of the provider.
   * @param asset - Asset used for payment.
   */
  constructor(
    chainId: string,
    sender: string,
    receiver: string,
    nonce: number,
    asset: string,
    ttl: number
  ) {
    const id = PaymentChannel.uuid();
    this._session = {
      id,
      chainId,
      sender,
      receiver,
      nonce,
      asset,
      state: {
        iteration: 0,
        amount: 0,
        expiry: 0,
        status: Status.OPEN,
      },
    };

    // Configure expiry period and then set initial expiry time.
    if (ttl < PaymentChannel.MIN_TTL) {
      throw new Error(
        `Given expiry period (${ttl}) is less than minimum expiry ` +
          `period (${PaymentChannel.MIN_TTL}).`
      );
    }
    this.TTL = ttl;
    this.pushExpiry();
  }

  public update(amount: number, signature: string) {
    this.assertOpen();
    this._session.state.iteration += 1;
    this._session.state.amount = amount;
    this._session.state.signature = signature;
    this.pushExpiry();
  }

  public close() {
    this._session.state.status = Status.CLOSED;
  }

  public isOpen(): boolean {
    if (this._session.state.status === Status.OPEN) {
      const isExpired = this.checkExpiry();
      return !isExpired;
    }
    return false;
  }

  public static uuid(): string {
    const dateStr = Date.now().toString(36); // Convert to base 36.

    const randomStr = Math.random().toString(36).substring(2, 8); // Start at index 2 to skip decimal point.

    return `${dateStr}-${randomStr}`;
  }

  private assertOpen() {
    // Check if status is closed.
    if (!this.isOpen()) {
      throw new Error("Session is closed.");
    }
  }

  private checkExpiry(): boolean {
    if (new Date().getTime() / 1000 > this._session.state.expiry) {
      return true;
    }
    return false;
  }

  private pushExpiry() {
    this.assertOpen();
    // Current time in seconds, plus configured expiry period.
    this._session.state.expiry = new Date().getTime() / 1000 + this.TTL;
  }
}

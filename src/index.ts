import { Static, Type } from "@sinclair/typebox";
import fastify, { FastifyInstance, FastifyReply } from "fastify";
import { ProviderNode } from "./ProviderNode.ts";
import * as dotenv from "dotenv";

import SepoliaPayments from "../artifacts/sepolia/Payments.sol/Payments.json" with { type: "json" };
import SepoliaTestERC20 from "../artifacts/sepolia/TestERC20.sol/TestERC20.json" with { type: "json" };
import SepoliaSemaphoreHSS from "../artifacts/sepolia/SemaphoreHSS.sol/SemaphoreHSS.json" with { type: "json" };

dotenv.config();

const AdminRequestSchema = Type.Object({
  adminToken: Type.String(),
  additions: Type.Optional(Type.Any()),
});
type AdminRequest = Static<typeof AdminRequestSchema>;

const ChannelRequestSchema = Type.Object({
  id: Type.String(),
  chainId: Type.Optional(Type.String()),
  subscriberAddress: Type.Optional(Type.String()),
  asset: Type.Optional(Type.String()),
  amount: Type.String(),
  expiry: Type.Number(),
  signature: Type.String(),
});
type ChannelRequest = Static<typeof ChannelRequestSchema>;

const IdGenRequestSchema = Type.Object({
  chainId: Type.String(),
  subscriberAddress: Type.String(),
});
type IdGenRequest = Static<typeof IdGenRequestSchema>;

type SemaphoreError = {
  message: string;
  type: string;
  context: any;
  stack?: string;
};

type ServerConfig = {
  server: {
    adminToken: string;
    port: number;
    host: string;
  };
  channels: {
    ttl: number;
  };
};

/**
 * Converts an error into a json-like object.
 *
 * @param error - Error to convert.
 * @returns SemaphoreError object.
 */
const formatError = (error: Error): SemaphoreError => {
  return {
    message: error.message,
    type: error.name,
    context: {},
    stack: error.stack,
  };
};

const api = {
  auth: {
    redeem: async (
      config: ServerConfig,
      provider: ProviderNode,
      body: AdminRequest,
      res: FastifyReply
    ) => {
      const { adminToken } = body;
      if (adminToken !== config.server.adminToken) {
        return res.status(401).send("Unauthorized to perform this operation.");
      }

      const numChannelsClosed = await provider.redeemChannels(
        config.channels.ttl
      );
      return res.status(200).send(
        JSON.stringify({
          closed: numChannelsClosed,
        })
      );
    },
  },
  get: {
    ping: async (res: FastifyReply) => {
      return res.status(200).send("pong\n");
    },
    uuid: async (
      provider: ProviderNode,
      body: IdGenRequest,
      res: FastifyReply
    ) => {
      const subscriber = body.subscriberAddress;
      const chainId = body.chainId;
      try {
        const id = await provider.generateId(chainId, subscriber);
        return res.status(200).send(JSON.stringify({ id }));
      } catch (e) {
        const json = formatError(e);
        return res.status(500).send(json);
      }
    },
  },
  post: {
    open: async (
      provider: ProviderNode,
      body: ChannelRequest,
      res: FastifyReply
    ) => {
      try {
        const {
          id,
          chainId,
          subscriberAddress,
          asset,
          amount,
          expiry,
          signature,
        } = body;
        // All optionals should be specified in order to open a new channel.
        if (!chainId) {
          throw new Error("Chain ID not specified.");
        }
        if (!subscriberAddress) {
          throw new Error("Subscriber address not specified.");
        }
        if (!asset) {
          throw new Error("Asset address not specified.");
        }

        // Open the channel using given ProviderNode instance.
        await provider.openChannel({
          id,
          chainId,
          subscriber: subscriberAddress,
          asset,
          amount,
          expiry,
          signature,
        });
        res.status(200).send(
          JSON.stringify({
            id,
          })
        );
      } catch (e) {
        const json = formatError(e);
        return res.status(500).send(json);
      }
    },
    update: async (
      provider: ProviderNode,
      body: ChannelRequest,
      res: FastifyReply
    ) => {
      try {
        const { id, amount, expiry, signature } = body;
        // Open the channel using given ProviderNode instance.
        await provider.updateChannel({
          id,
          amount,
          expiry,
          signature,
        });
        res.status(200).send(
          JSON.stringify({
            id,
          })
        );
      } catch (e) {
        const json = formatError(e);
        return res.status(500).send(json);
      }
    },
  },
};

async function main() {
  const mnemonic = process.env.MNEMONIC;
  if (!mnemonic) {
    throw new Error("No mnemonic found. Please define MNEMONIC in .env.");
  }
  const provider = new ProviderNode(
    mnemonic,
    {
      // TODO: Support for other chains, use a JSON config, etc.
      "11155111": {
        providers: ["https://rpc2.sepolia.org"],
        assets: [SepoliaTestERC20.address],
        contracts: {
          Payments: {
            abi: SepoliaPayments.abi,
            address: SepoliaPayments.address,
          },
          SemaphoreHSS: {
            abi: SepoliaSemaphoreHSS.abi,
            address: SepoliaSemaphoreHSS.address,
          },
        },
      },
    },
    // Setting expiry tolerance to 2 days. Any new channels being opened must have an expiry
    // equal or greater to this amount of time.
    60 * 60 * 48
  );

  const config: ServerConfig = {
    server: {
      adminToken: process.env.ADMIN_TOKEN,
      port: parseInt(process.env.PORT),
      host: process.env.HOST,
    },
    channels: {
      // Time-to-live since last update.
      ttl: 30 * 60, // 30 minutes.
    },
  };
  const server: FastifyInstance = fastify();

  server.get("/ping", (_, res) => api.get.ping(res));

  server.get<{ Body: IdGenRequest }>("/uuid", (req, res) =>
    api.get.uuid(provider, req.body, res)
  );

  server.post<{ Body: AdminRequest }>(
    "/channels/redeem",
    { schema: { body: AdminRequestSchema } },
    async (req, res) => api.auth.redeem(config, provider, req.body, res)
  );

  server.post<{ Body: ChannelRequest }>(
    "/channels/open",
    { schema: { body: ChannelRequestSchema } },
    async (req, res) => api.post.open(provider, req.body, res)
  );

  server.post<{ Body: ChannelRequest }>(
    "/channels/update",
    { schema: { body: ChannelRequestSchema } },
    async (req, res) => api.post.update(provider, req.body, res)
  );

  const address = await server.listen({
    port: config.server.port,
    host: config.server.host,
  });
  console.log(`Server listening at ${address}`);
}

main();

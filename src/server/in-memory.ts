import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Identity } from "../types/domain.js";
import type { AppServices } from "./bootstrap.js";
import { createKnowledgeServer } from "./index.js";
import { createStaticSession } from "./session.js";

/** Connects a real MCP client to a server instance in-process (used by the demo and integration tests). */
export async function connectInMemoryClient(
  services: AppServices,
  identity: Identity,
  clientName: string,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createKnowledgeServer(services, createStaticSession(identity));
  await server.connect(serverTransport);
  const client = new Client({ name: clientName, version: "1.0.0" });
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

export async function callToolText(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const text = result.content
    .map((item) => {
      if (item.type === "text") return item.text;
      if (item.type === "resource" && "text" in item.resource) return item.resource.text;
      return "";
    })
    .join("\n");
  return { text, isError: result.isError === true };
}

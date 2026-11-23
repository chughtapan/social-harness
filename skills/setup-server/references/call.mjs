// Calls one tool on a Social Harness server: node call.mjs <tool> ['<json arguments>']
// Run it from a checkout with dependencies installed. SERVER_URL and TOKEN come from the environment.
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

const [tool, args = "{}"] = process.argv.slice(2);
const client = new Client({ name: "call", version: "0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(process.env.SERVER_URL), {
    requestInit: { headers: { Authorization: `Bearer ${process.env.TOKEN}` } },
  }),
);
const result = await client.callTool({
  name: tool,
  arguments: JSON.parse(args),
});
console.log(JSON.stringify(result.structuredContent ?? result.content));
await client.close();

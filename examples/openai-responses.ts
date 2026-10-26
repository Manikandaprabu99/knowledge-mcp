// Example only (not part of the build). Needs OPENAI_API_KEY, UKM_TOKEN, and a server reachable over public HTTPS.
// Run with: npx tsx examples/openai-responses.ts
const response = await fetch("https://api.openai.com/v1/responses", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
  body: JSON.stringify({
    model: process.env.OPENAI_MODEL ?? "gpt-4.1",
    tools: [
      {
        type: "mcp",
        server_label: "knowledge",
        server_url: process.env.UKM_URL ?? "https://knowledge.example.com/mcp",
        headers: { Authorization: `Bearer ${process.env.UKM_TOKEN}` },
        require_approval: "never",
      },
    ],
    input: "Search the knowledge store first: why is my PostgreSQL JSONB @> query slow?",
  }),
});
process.stdout.write(`${JSON.stringify(await response.json(), null, 2)}\n`);

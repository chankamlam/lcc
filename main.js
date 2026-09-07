const { exec } = require("node:child_process");
const Anthropic = require("@anthropic-ai/sdk");
const loadenv = require('loadenv');

loadenv()

const baseUrl = process.env.ANTHROPIC_BASE_URL;
const apiKey = process.env.ANTHROPIC_AUTH_TOKEN;
const model = process.env.MODEL_ID;
const workspace = process.cwd();
const systemPrompt = `You are a coding agent at ${workspace}. Use bash to solve tasks. Act, don't explain.`;
const toggleHistory = false;


const client = new Anthropic({
  baseURL: baseUrl,
  apiKey: apiKey,
});


const TOOLS = [
  {
    name: "bash",
    description: "Run a shell command.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
];

function runBash(command) {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) {
    return Promise.resolve("Error: Dangerous command blocked");
  }
  return new Promise((resolve) => {
    exec(
      command,
      { cwd: workspace, shell: "/bin/sh", timeout: 120000, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && error.killed) return resolve("Error: Timeout (120s)");
        const out = `${stdout}${stderr}`.trim();
        resolve(out ? out.slice(0, 50000) : "(no output)");
      }
    );
  });
}

function callLLM(messages) {
  return client.messages.create({
    model,
    system: systemPrompt,
    messages,
    tools: TOOLS,
    max_tokens: 8000,
  });
}

const COLORS = {
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  green: "\x1b[32m",
  white: "\x1b[37m",
  reset: "\x1b[0m"
};

function printWithColor(message, color = "white") {
  const code = COLORS[color] ?? COLORS.white;
  console.log(`${code}${message}${COLORS.reset}`);
}

function printHistory(history) {
  if (!toggleHistory) return
  console.log("\n=== HISTORY DETAIL START ===");
  for (const h of history) {
    console.log('%o', h);
  }
  console.log("=== HISTORY DETAIL END ===\n");
}

function printLLMResponse(history) {
  const last_content = history.at(-1).content;
  for (const block of last_content) {
    if (block.type === "text") printWithColor(block.text, "blue");
  }
}

function printHeader(text) {
  printWithColor(text, "red")
}

async function agentLoop(messages) {
  while (true) {
    const res = await callLLM(messages);
    // Append assistant turn
    messages.push({ role: "assistant", content: res.content });

    // none tool use then return
    if (res.stop_reason !== "tool_use") return;

    // Execute each tool call, collect results
    const results = [];

    for (const block of res.content) {
      if (block.type !== "tool_use") continue;
      const output = await runBash(block.input.command);
      results.push({ type: "tool_result", tool_use_id: block.id, content: output });
    }
    // Feed tool results back, loop continues
    messages.push({ role: "user", content: results });
  }
}

async function main() {

  printHeader(`
==========================
S01 => Agent Loop
Workspace: ${workspace}
Input the prompt or type q to quit:
==========================
`);
  const history = [];
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  while (true) {
    const query = await rl.question(">>> ");
    if (query.trim().toLowerCase() === "q") break;
    history.push({ role: "user", content: query });

    await agentLoop(history);

    printHistory(history);

    printLLMResponse(history);
  }

  rl.close();

}

main().catch(console.error);

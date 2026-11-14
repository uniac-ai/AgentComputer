// A client in a process of its own, so it can trust a test certificate through
// NODE_EXTRA_CA_CERTS. It attaches this computer with a workspace, or makes one in a container
// without, runs a command on it and removes it.
import { Computer } from "../../dist/sdk.js";

const [apiUrl, apiKey, access, workspace] = process.argv.slice(2);
const to = { apiUrl, apiKey };
const deadline = Date.now() + 30_000;
for (;;) {
  try {
    await Computer.serviceInfo(to);
    break;
  } catch (error) {
    if (Date.now() > deadline) throw error;
    await new Promise((done) => setTimeout(done, 200));
  }
}
const computer = await (workspace
  ? Computer.attach({ ...to, access, workspace })
  : Computer.create({ ...to, access }));
const { output } = await computer.commands.run("echo across");
const answer = { output, endpoint: computer.getMcpUrl() };
await computer.kill();
process.stdout.write(`${JSON.stringify(answer)}\n`);

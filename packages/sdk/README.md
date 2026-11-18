# AgentComputer's SDK

The TypeScript client of [AgentComputer](https://github.com/uniac-ai/AgentComputer). It makes and attaches computers for agents, runs commands, reads and writes files, and gives an MCP client a computer's address and token. [AgentComputer's README](https://github.com/uniac-ai/AgentComputer#sdk) says how to use it. The API it speaks is [`packages/contract/openapi.yaml`](https://github.com/uniac-ai/AgentComputer/blob/main/packages/contract/openapi.yaml).

`npm install @agentorg/computer-sdk@next` installs it: one file with no dependencies, `dist/sdk.js`, with its types in `dist/types`. The service's package, `@agentorg/computer`, exports the same file at the same version, and is released with it. The repository's `npm run build` bundles it from `src/sdk.ts` and what that imports.

# AgentComputer

Computers for agents, as a service. Each computer is a working folder, a terminal and files from [AgentExec](https://github.com/uniac-ai/AgentExec) at a level you choose, and a browser from Playwright MCP if you ask for one. Any MCP client can use them.

```sh
npm install -g agentcomputer
agentcomputer serve
```

In another terminal:

```sh
agentcomputer create --access terminal --browser --workspace ~/some/folder
```

That prints the computer's `computerID`, its endpoints and its `accessToken`, once. Give an MCP client the `computer` and `browser` URLs, with the token as `Authorization: Bearer <token>`.

**This version has no isolation.** A computer is processes of whoever started the service. With `--access terminal` it can reach everything that user can. Run it only where that's safe.

## Access

| `--access` | Tools at the `computer` endpoint          |
| ---------- | ----------------------------------------- |
| `read`     | `read`, `list`, `search`                  |
| `files`    | Those, and `edit`                         |
| `terminal` | Those, and `exec_command`, `write_stdin`  |
| `none`     | No `computer` endpoint; needs `--browser` |

The file tools stay inside the workspace. That's a check, not a boundary. Below `terminal`, the browser's `browser_run_code_unsafe` tool is hidden and refused, because it would otherwise be a terminal. The service enforces all of this, whatever the client does.

`--browser` drives the Google Chrome installed on the machine, in a profile of the computer's own. `serve --browser-name` and `--browser-path` choose another.

## Commands

|                                           |                                                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `serve`                                   | Run the service: `--listen` (127.0.0.1:7878), `--data`                                                 |
| `info`                                    | The service's version and isolation                                                                    |
| `create`                                  | Make a computer: `--access`, `--browser`, `--workspace`, `--name`, `--timeout`, `--metadata KEY=VALUE` |
| `list [--state]`, `get <id>`, `logs <id>` | Look at them                                                                                           |
| `timeout <id> <seconds>`                  | It now stops this long from now                                                                        |
| `stop <id>`, `start <id> [--timeout]`     | Stop it, keeping its folder and token; start it again                                                  |
| `kill <id>`                               | Stop it and remove what the service made                                                               |

With no `--workspace`, the service makes a folder, which goes when the computer is killed. A folder you name is never deleted. A computer with a `--timeout` stops when it runs out, and its folder stays.

The service listens on loopback. It refuses any other address, because it has no TLS yet.

The data folder is `--data`, else `$AGENTCOMPUTER_DATA`, else `$XDG_DATA_HOME/agentcomputer`, else `~/.local/share/agentcomputer`. It holds `control-token` and `server.json`, which the commands read.

## API

[`openapi.yaml`](openapi.yaml) defines every operation, and a running service publishes it at `/openapi.json`. The HTTP API and the MCP control tools are generated from it and answered by the same handlers, and the SDK's types come from it.

| Operation                                 | MCP tool at `/v1/mcp`  |
| ----------------------------------------- | ---------------------- |
| `GET /v1/info`                            | `service_info`         |
| `POST /v1/computers`                      | `computer_create`      |
| `GET /v1/computers`                       | `computer_list`        |
| `GET /v1/computers/{computerID}`          | `computer_get`         |
| `DELETE /v1/computers/{computerID}`       | `computer_kill`        |
| `POST /v1/computers/{computerID}/timeout` | `computer_set_timeout` |
| `POST /v1/computers/{computerID}/stop`    | `computer_stop`        |
| `POST /v1/computers/{computerID}/start`   | `computer_start`       |
| `GET /v1/computers/{computerID}/logs`     | `computer_logs`        |

These take the control token, kept in the data folder. A computer's own endpoints take its `accessToken`, and neither token works for the other:

```
/v1/computers/{computerID}/mcp/computer   MCP over Streamable HTTP
/v1/computers/{computerID}/mcp/browser    MCP over Streamable HTTP
```

`POST /v1/computers` is the only place an `accessToken` is shown. Failures are `{ "code": 404, "message": "..." }`.

## Known limits

- Each browser's Playwright MCP listens on a loopback port with no token of its own, so another user on the same machine could reach it directly. Don't run this on a machine you share.
- A browser that stops shows the computer as `failed`. Stop it and start it again.

## Tests

`npm test` runs the built service through the official MCP client, with a stand-in for Playwright. After changing `openapi.yaml`, `npm run generate` writes what comes from it; CI fails if that changes anything. Set `AGENTCOMPUTER_BROWSER_PATH` to a browser program to run the real one too.

## Licence

Apache-2.0.

# AgentComputer

Computers for agents, as a service. Each computer is a working folder, a terminal and files from [AgentExec](https://github.com/uniac-ai/AgentExec) at a level you choose, and a browser from Playwright MCP if you ask for one. Any MCP client can use them.

```sh
npm install -g @agentorg/computer
agentcomputer serve
```

In another terminal, or after `agentcomputer up`, which runs it in the background instead:

```sh
agentcomputer create --access terminal --browser --workspace ~/some/folder
```

That prints the computer's `computerID`, its endpoints and its `accessToken`, once. Give an MCP client the `computer` and `browser` URLs, with the token as `Authorization: Bearer <token>`.

**By default a computer has no isolation.** It's processes of whoever started the service, and with `--access terminal` it can reach everything that user can. Use `--isolation container` wherever that isn't safe.

## Isolation

`agentcomputer serve --isolation container` makes each computer a container of its own, which needs Docker on the same machine. The service follows your `DOCKER_HOST` or current context and never changes them.

- The image holds AgentExec, Playwright MCP and a headless Chromium. It is `ghcr.io/uniac-ai/agentcomputer/computer` at the service's version; `--image` names another.
- `--workspace` is mounted at `/workspace`, read-only at `--access read`, and nothing else of the machine is visible. The computer is told that folder's path on the machine and the machine's name, which `about` answers. Docker has to be able to share that folder. Without `--workspace`, the service makes one.
- It runs as the user who started the service, with no capabilities.
- `stop` stops the container and keeps it, so what was installed in it is there at `start`. `kill` removes it. Starting a stopped computer uses the image it was made from.

## Access

| `--access` | Tools at the `computer` endpoint                          |
| ---------- | --------------------------------------------------------- |
| `read`     | `about`, `read`, `list`, `search`                         |
| `files`    | Those, and `edit`                                         |
| `terminal` | Those, and `exec_command`, `write_stdin`, `list_sessions` |
| `none`     | No `computer` endpoint; needs `--browser`                 |

`read` answers a text file as numbered lines, and a PNG, JPEG, GIF or WebP of up to 3 MiB as the picture itself: an image an MCP client can pass on to a model. The browser's `browser_take_screenshot` answers an image too, of whatever size it comes to: a `fullPage` one of a long page can be many megabytes. A container made by an earlier version keeps the program it was made with, and refuses a picture as a binary file until it is killed and made again.

`about` tells the agent what a person looking at the computer reads. It takes nothing and answers JSON text, `{"rows": [...]}`, each row a `label` and a `value`, with `"path": true` on a value that is a path and `"caution": true` on one to be read as a caution; a row that is neither has neither. The rows come in this order:

| `label`     | `value`                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------- |
| `Where`     | The machine's own name                                                                    |
| `Folder`    | The workspace's path on that machine, as a path                                           |
| `Reaches`   | `Read-only files`, `Files`, or `Files and terminal`; with a browser, `, Browser` after it |
| `Isolation` | `None: it acts as you`, as a caution, or `A container of its own`                         |
| `CPU`       | Used, of all the machine's CPUs, as a whole percentage: `37%`                             |
| `Memory`    | Used of the machine's total, counted in 1024s and written GB: `9.2 of 16 GB`              |
| `Disk`      | Used of total, of the volume the workspace is on, counted in 1000s: `212 of 494 GB`       |

- **In a container** the agent's commands find the folder somewhere else, so `Folder` says both and is not marked as a path: `/home/me/Research on the machine, mounted at /workspace in it`. CPU and Memory there are the computer's own; with no isolation they are the whole machine's.
- **The last three** are a reading of its load taken over half a second when it is asked, in the same way the `load` surface reads. They come together, or not at all where a reading can't be taken.
- **Not every computer has it.** One with no `computer` endpoint has no `about`. One in a container made by an earlier version keeps the program it was made with: `about` is listed among its tools and isn't there until it is killed and made again.

The file tools stay inside the workspace. That's a check, not a boundary. Below `terminal`, the browser's `browser_run_code_unsafe` tool is hidden and refused, because it would otherwise be a terminal. The browser's endpoint takes one JSON-RPC request in each POST, as a JSON object, and refuses anything else with 400, a batch among them: it checks each request before passing it on, and passes on only what it read. The service enforces all of this, whatever the client does.

`--browser` drives the Google Chrome installed on the machine, in a profile of the computer's own. `serve --browser-name` and `--browser-path` choose another. The browser has no debug port: a small host process starts it and shares it on a Unix socket in a folder only its user can enter, which the agent's tools and the live view both use. It lives as long as its computer does: a client that ends its session or goes away leaves the browser and its pages as they are, and the agent's `browser_close` is refused. Only an agent with `--access terminal` can stop it, with `browser_run_code_unsafe` or from its terminal.

## Commands

|                                           |                                                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `serve`                                   | Run the service: `--listen` (127.0.0.1:7878), `--data`                                                 |
| `up`, `down`, `status`                    | Run the service in the background, stop it, say where it is running                                    |
| `info`                                    | The service's version and isolation                                                                    |
| `create`                                  | Make a computer: `--access`, `--browser`, `--workspace`, `--name`, `--timeout`, `--metadata KEY=VALUE` |
| `list [--state]`, `get <id>`, `logs <id>` | Look at them                                                                                           |
| `timeout <id> <seconds>`                  | It now stops this long from now                                                                        |
| `stop <id>`, `start <id> [--timeout]`     | Stop it, keeping its folder and token; start it again                                                  |
| `live <id> --surface [--mode]`            | A one-time ticket to open one of its surfaces live; see [Live sessions](#live-sessions)                |
| `kill <id>`                               | Stop it and remove what the service made                                                               |

**In the background.** `up` takes what `serve` takes, runs the service in the background for you, and returns once it answers, printing its `url`, `pid`, version and isolation. If one is already running for the data folder it prints that one and starts nothing, so whatever starts it, there is one. `status` prints the same, or exits 1 with none running. `down` ends it and says nothing; its computers stop with it, and start again when it next does. `serve` won't run beside a service that has the same data folder. `--version` prints the program's version, with no service.

- What the service writes goes to `service.log` in the data folder, of which `up` keeps the last 1 MiB.
- It stays when whatever started it goes, and nothing starts it when the machine does. To have it at login, a shell profile can run `agentcomputer up`; a supervisor such as launchd or a systemd user unit is given `agentcomputer serve`, which it keeps in the foreground.
- `up`, `down` and `status` are for a service on this machine that this machine can reach at its address.
- `start` and `stop` are a computer's and take its id. With the id left out they stop nothing, and say so.

With no `--workspace`, the service makes a folder, which goes when the computer is killed. A folder you name is never deleted. A computer with a `--timeout` stops when it runs out, and its folder stays.

The service listens on loopback unless you give it TLS; see [Across a network](#across-a-network).

The data folder is `--data`, else `$AGENTCOMPUTER_DATA`, else `$XDG_DATA_HOME/agentcomputer`, else `~/.local/share/agentcomputer`. It holds `control-token` and `server.json`, which the commands read; a `server.json` left by a service that crashed names nothing, and is seen through.

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
| `POST /v1/computers/{computerID}/live`    | `computer_live`        |

These take the control token, kept in the data folder. A computer's own endpoints take its `accessToken`, and neither token works for the other:

```
/v1/computers/{computerID}/mcp/computer   MCP over Streamable HTTP
/v1/computers/{computerID}/mcp/browser    MCP over Streamable HTTP
```

`POST /v1/computers` is the only place an `accessToken` is shown. Failures are `{ "code": 404, "message": "..." }`.

## SDK

```ts
import { Computer } from "@agentorg/computer";

const computer = await Computer.create({ access: "terminal", browser: true, timeoutMs: 600_000 });
const { exitCode, output } = await computer.commands.run("ls -la");
await computer.files.write("notes.txt", "hello\n");
const notes = await computer.files.read("notes.txt");
await computer.kill();
```

It reads the control token from `AGENTCOMPUTER_API_KEY` and the address from `AGENTCOMPUTER_API_URL`, or takes `apiKey` and `apiUrl` as options. `computer.getMcpUrl("browser")` and `computer.getMcpToken()` give an MCP client what it needs, and `Computer.connect(id, { accessToken })` picks up a computer made earlier.

`files.write` makes a new file or fills an empty one; `files.edit` changes one that has content. `files.read` returns the whole text, or fails if a line is longer than the tool can return.

## Across a network

The service listens on loopback unless you give it TLS:

```sh
agentcomputer serve --listen 0.0.0.0:7878 \
  --tls-cert cert.pem --tls-key key.pem --public-url https://computers.example.com:7878
```

`--tls-proxy` is the other way, when a proxy in front of it terminates TLS. It then listens in the clear, so keep that hop private. `--public-url` is the address clients reach it at, which the endpoints it gives out are built from. It's required with `--tls-proxy` and when listening on a wildcard address. Certificates are read at start, so restart it to renew one.

A client using a private certificate authority trusts it through `NODE_EXTRA_CA_CERTS`.

### The service as a container

`ghcr.io/uniac-ai/agentcomputer/service` holds the service and the Docker client, for container isolation on a server:

```sh
docker run -d --name agentcomputer --network host \
  --user "$(id -u):$(id -g)" --group-add "$(stat -c %g /var/run/docker.sock)" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /srv/agentcomputer:/srv/agentcomputer \
  ghcr.io/uniac-ai/agentcomputer/service:VERSION \
  serve --isolation container --data /srv/agentcomputer --listen 0.0.0.0:7878 \
  --tls-cert /srv/agentcomputer/cert.pem --tls-key /srv/agentcomputer/key.pem \
  --public-url https://computers.example.com:7878
```

- Its data folder, and any `--workspace`, have to be mounted at the same path inside as outside, because Docker reads those paths on the machine.
- `--network host` is how it reaches each computer's port on the machine's loopback, so this needs Linux.
- The socket gives it full control of that machine's Docker. Whoever holds the control token can make computers, but not reach the socket.

## Live sessions

A computer at `--access terminal` has a surface you can open live, as a WebSocket:

- **`terminal`** (protocol `terminal@1`): every terminal on it, on one socket. A terminal is a command the agent started or a shell a person opened, and they are one list: you read and type into the agent's commands, and the agent lists, reads and types into your shell, with `list_sessions` and `write_stdin`. Every message is JSON text, and `openapi.yaml` has each one's fields.
  - **The service sends** `start` (with `by`, which is `agent` or `person`, `cmd`, `workdir` and `tty`), `output` (with `text`, and `stream` unless the terminal is on a terminal device) and `exit` (with `exitCode`). Each carries the terminal's `id`, which is the `session_id` the agent's tools use. A new socket is first sent each terminal already there, the last 64 that ended among them, with the last 65,536 characters it wrote, as one text with no `stream`.
  - **An `operate` socket sends** `open` (with `columns` and `rows`) to start a shell of your own in the workspace, as its user, which arrives as a `start` like any other; `input` (with `id` and `text`) to type into any running terminal; `resize`; and `stop`, which interrupts a command or hangs up a shell, and kills it a second later. A `watch` socket reads everything, and what it sends is dropped.
  - **`by` is only the way in:** through a tool, or through this surface. Nothing says which client or person it was, and anyone who can operate the surface, like any agent with the tools, reaches every terminal.
  - **A command isn't on a terminal device** (`tty` is false): it echoes nothing you type, Enter is a line feed, and it has no size. In it Ctrl-C (U+0003) interrupts and Ctrl-D (U+0004) ends its input. A shell is on one, and what the agent types into it goes in as keys. Its size is the last `resize` anyone sent, and nothing tells it.
  - **What can't be done is answered with `refused`,** with why in `message`, only to the socket that asked: input or a size for a terminal that has ended or isn't there, a size for a command or out of range, a shell past the 64 terminals that may run at once, or a message that is none of these. What was done is answered by its event. Stopping a terminal that has ended does nothing.
  - No message is over 65,536 bytes: a longer piece of output comes as several messages, and a larger message from you closes the socket, so send a long text as several inputs.
  - **A socket with more than 4 MiB still to be sent to it is closed,** with no close frame (your side sees 1006). That is a viewer that has stopped reading, and it can be one that is reading while a terminal writes tens of megabytes at once. It isn't an error: open the surface again, drop what you held of every terminal, and take what you are sent, which is each terminal afresh with the last 65,536 characters it wrote.

A computer at `--access read` or above has another, and at `read` it is the only one:

- **`files`** (protocol `files@1`): its workspace's files, for a file window. Text messages are JSON, and each request has an `id` of your choosing, which its answer repeats. `openapi.yaml` has each one's fields.
  - **`list`** is answered with `entries`: a folder's entries with their kind, size and date, folders first, the first thousand. With them come `path`, the folder as it was asked for, and `workspace`, what the workspace is called: its folder's own name, and nothing of where it is. The two together name the folder, `Research/src`; a workspace the service made is called `workspace`, and one at the top of a disk has an empty name. A computer in a container made before `workspace` was added sends none, and then `path` alone names the folder.
  - **`read`** is answered with `data` and then one binary message, a range of a file's bytes. A file larger than one range is read by asking again from where the last ended.
  - **`changed`** is answered with `changes`: the files modified after a time, the newest thousand, the newest first. It skips what `.gitignore` files ignore, `.git`, `node_modules` and links, and a file that was removed isn't one of them. Each one asked walks the workspace once, a computer walks for one at a time, and nothing is walked that wasn't asked for.
  - **`write`**, on an `operate` socket, puts a file there a part at a time, each followed at once by one binary message, its bytes. Nothing is at the path until the part marked `last`, which puts the file there whole and is answered with `written`; the parts before it are answered only if one is refused. It makes no folders, and nothing removes or renames a file. A file not finished when the socket closes is given up.
  - **`refused`**, with why, answers whatever it won't do. Answers come as they are ready, in any order.
  - No message is over 1,048,576 bytes: a larger one closes the socket, as do bytes that follow no `write`. Paths are from the workspace, with `/` between their parts, and nothing outside it is reached. A `watch` socket lists and reads and can't write, and a computer at `--access read` offers `files` to watch only.

A computer with `--browser` has another:

- **`browser`** (protocol `screencast@1`): its browser, the one the agent works in. Binary messages are JPEG frames of the page shown. Text messages are JSON: the service sends `tabs`, `viewport`, `dialog`, `file-chooser` and `choice`, and an `operate` socket sends `mouse`, `key`, `text`, `dialog`, `files`, `choice`, `tab` and `navigate`. `openapi.yaml` has each one's fields. A page's own dialogs, file choosers and select lists aren't in the frames, so they arrive as events for you to show and answer.
  - **Nobody waits for anybody.** The agent's tools and your input act on the same browser at once. Nothing holds the agent off while you type, and nothing tells it you touched a page. On a page you both use, your input and its actions interleave, so open a tab to work apart from it.
  - **The page shown is each socket's own,** and its input goes to that page. A socket is shown each new tab as it opens, which is how watching follows the work. Once it sends a `tab` input to show or open one, its page stays its own and changes only when that page closes, when it is shown the newest that is left. A `watch` socket can't send one, so it always follows.
  - **The tabs are shared all the same.** The agent's tools list, select and close every tab, yours included, and your `tab` input can close any of them, the agent's included. When the tab the agent is on closes, it moves to the one beside it. The service can't say which tab the agent is on.
  - **A dialog, a file chooser and a list belong to a page.** A dialog is told to the sockets shown its page until someone answers it, you or the agent. Nothing says when the agent answers a file chooser, so when it answers one every open chooser is taken as closed: press again if yours was.
  - **A client written for the earlier `screencast@1` still connects.** Its `release` is ignored and no `driver` event comes: nobody holds the browser any more.

Every running computer has one more, to watch only:

- **`load`** (protocol `metrics@1`): how busy it is. The service sends a reading every two seconds while a socket is open, the first two seconds after the first socket opens, and the last one at once to a socket that opens later: `{"type":"reading","scope":"machine","cpuUsedPct":37.2,"memUsed":…,"memTotal":…,"diskUsed":…,"diskTotal":…}`, in bytes. `openapi.yaml` has each field, as `LoadReading`.
  - **`scope` says whose numbers they are.** A computer in a container reads its own (`computer`), against the machine's totals, since a container has no limit of its own. A computer with no isolation has no edge to measure at, so it reads the whole machine's (`machine`), as every other computer of that service does; so does a container that can't read its own.
  - **The disk is the volume its workspace is on,** not the workspace's own size.
  - **Nothing depends on it.** Nothing is read while nobody watches or asks, a reading that can't be taken is left out, and a socket that hasn't read the one before is not sent the next.

`POST /v1/computers/{computerID}/live` with `{ "surface": "terminal", "mode": "operate" }` gives a ticket: a `url` to open once within a minute, which needs no token. A request with an `Origin` header is refused unless `serve --allow-origin` names that origin, so a page can't open one. The SDK does the same with `computer.terminals.connect({ onEvent })`, or gives the ticket alone with `computer.liveSession("files")` or `computer.liveSession("browser", "operate")`, and the CLI with `agentcomputer live <id> --surface terminal --mode operate`.

A shell of your own needs [node-pty](https://github.com/microsoft/node-pty), an optional dependency installed beside the program. It comes prebuilt for macOS. On Linux it's compiled at install, which npm only does when told: `npm install -g @agentorg/computer --allow-scripts=node-pty`, with a C++ toolchain. Without it, the agent's commands run and show as ever, and only `open` is refused, saying why. The computer image has it.

## Known limits

- With no isolation, each browser's Playwright MCP listens on a loopback port with no token of its own, so another user on the same machine could reach it directly. Don't run that on a machine you share.
- A container has no CPU or memory limit, and its network is Docker's default, so it reaches the internet and anything else Docker's network does.
- In a container the browser runs without its own sandbox, which needs privileges a computer doesn't have. The container is the boundary.
- A browser that stops, or a container that ends by itself, shows the computer as `failed`, and what can no longer be opened live says so in `surfaces`. Stop the computer and start it again.
- A file being written through the `files` surface sits beside its path as `.agentexec-…` until its last part, where a listing, and the agent, can see it. It stays if the service dies meanwhile.

## Tests

`npm test` runs the built service through the official MCP client, and one scenario through HTTP, MCP, the SDK and the CLI that fails if any operation in the schema isn't reached by each. Set `AGENTCOMPUTER_TEST_IMAGE` to a built image (`npm run build`, then `docker build .`) to run the same suite on containers, and `AGENTCOMPUTER_TEST_SERVICE_IMAGE` to one from `Dockerfile.service` to run the service itself as a container, with `AGENTCOMPUTER_TEST_ROOT` naming a folder Docker can mount if the temporary one isn't. After changing `openapi.yaml`, `npm run generate` writes what comes from it; CI fails if that changes anything. Set `AGENTCOMPUTER_BROWSER_PATH` to a Chromium program, such as Playwright's headless shell, to run the browser tests that are skipped without it.

## Licence

Apache-2.0.

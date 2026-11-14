# AgentComputer

Computers for agents, as a service. Each computer is a working folder, a terminal and files from [AgentExec](https://github.com/uniac-ai/AgentExec) at a level you choose, and a browser from Playwright MCP if you ask for one. It is this computer, the machine the service runs on, attached whole, or one made in a container of its own. Any MCP client can use them.

```sh
npm install -g @agentorg/computer
agentcomputer serve
```

In another terminal, or after `agentcomputer up`, which runs it in the background instead:

```sh
agentcomputer create --access terminal --browser --workspace ~/some/folder
```

That makes a computer in a container, which needs Docker, and prints its `computerID`, its endpoints and its `accessToken`, once. Give an MCP client the `computer` and `browser` URLs, with the token as `Authorization: Bearer <token>`.

```sh
agentcomputer attach --access terminal --workspace ~/some/folder
```

That gives an agent this computer instead: the machine the service runs on, whole, acting as you. With `--access terminal` it can reach everything you can. The folder is where its work starts, not a wall.

## This computer and containers

Each computer is this computer, attached with `attach`, or one made in a container of its own with `create`. A container needs Docker on the service's machine. The service follows your `DOCKER_HOST` or current context and never changes them, and comes up without Docker.

- **`info` says what the service offers**, each part ready or not and why, in a line a person reads:
  - `thisComputer`: its capabilities (`about`, `terminal`, `files` and `screen`) and the browsers that can go with it. Its screen isn't reached yet: `This service can't reach the screen yet.`
  - `made`, each kind it makes: today a container, ready while Docker answers, with its capabilities and browsers.
- **A container is refused with 409 where Docker doesn't answer:** `A container needs Docker, which isn't answering on this machine.` One already made isn't started there, and isn't killed there either, since its container couldn't be removed: both are refused with the same words, and it is kept.
- **A computer with no isolation is no longer made.** `create --isolation none` is refused with 400, and `attach` is what does that now.
- **Attach can be called as often as you like.** Each call attaches this computer as a computer of its own, with its own id, token and name, to give to one agent.

This computer:

- **It is offered only by a service that no other machine reaches:** one that listens on loopback, with no `--tls-proxy` and no `--public-url`. A service that other machines can reach is a server, and doesn't offer its own machine. There `info` says why, attaching is refused with 409 in the same words, and a computer attached before is refused at start.
- **`--workspace`, which `attach` needs, is its work folder.** Commands and relative paths start there, and `about` names it. But its files reach the whole machine, as whoever started the service, and so do its commands at `--access terminal`.
- **`kill` detaches it.** What the service kept for it goes, and nothing of the machine's.
- **Its browser,** with `--browser`, is a headless one with a profile of its own. It runs the Chrome installed on the machine, or what `serve --browser-name` or `--browser-path` names. `info` says whether that program is there.

**Upgrading from 0.0.18 or earlier:**

- **`create` with no `--isolation` used to make a computer with no isolation.** It now makes a container, which needs Docker, and is refused with 409 without it. To work on this machine as before, `attach` with `--workspace`.
- **`serve` and `up` no longer take `--isolation`, and won't start with it.** Remove it from whatever starts the service: a shell profile, a launchd or systemd unit, a `docker run` line.
- **A computer made with no isolation isn't started again.** Its record and folder are kept.
  - One that was running when the service last stopped is failed when it starts, and its `logs` say why. One that was stopped stays stopped.
  - Starting it is refused with 409, in words that say where its folder is and what to do instead: `A computer with no isolation is no longer made. Its folder is kept at <path>. Attach this computer with that folder as its work folder, or make a container whose workspace starts as a copy of it.`
  - In the API it is the one computer with `isolation` `none` and `attached` false, and its `workspace` is that folder.
  - Killing it removes the rest of it and keeps that folder, even one the service made in its data folder. Kill it first, then attach this computer with the folder as its `--workspace`, or make a container whose workspace starts as a copy of it: `create --copy-from <path>`.
- **A computer recorded by 0.0.14 or earlier kept no isolation,** and is taken as made with none, which was the default then. If you made computers in containers with 0.0.14 or earlier, run 0.0.18 once first, started as it was last started, so that each one's isolation is recorded. Otherwise each is refused as above, and killing one leaves its container behind.

A computer in a container:

- Its image holds AgentExec, Playwright MCP and a headless Chromium. It is `ghcr.io/uniac-ai/agentcomputer/computer` at the service's version; `--image` names another.
- `--workspace` is mounted at `/workspace`, read-only at `--access read`, and nothing else of the machine is visible. The computer is told that folder's path on the machine and the machine's name, which `about` answers. Docker has to be able to share that folder, and the data folder, where its home is. Without `--workspace`, the service makes one, in the data folder.
- `--copy-from DIR` (`copyFrom`), used instead of `--workspace`, has the folder the service makes start with a copy of what is in `DIR`, taken once when the computer is made. `DIR` itself is never mounted or changed. Links are copied as they are, and sockets, pipes and devices are left out. It needs `--access` other than `none`.
- The image is fetched the first time it is needed, which can take minutes: when the first computer in a container is made, a call that then waits for it. `docker pull` it beforehand to spare that wait.
- It runs as the user who started the service, with no capabilities.
- Its home, `/home/computer`, is a folder of the machine's, in the computer's own folder in the data folder, mounted as the workspace is. What the agent keeps there stays, the browser's profile with its sign-ins among it. `stop` stops the container and keeps it, and `kill` removes it with the computer's folder.
- **After an update,** a computer in a container is made again at its first start under a new version of the service, or under another `--image`: its container is removed and made again from the service's image. It keeps its workspace, its home, and its id, token, endpoints and settings. It loses its running commands, as at any restart, and everything else in the container: software installed there, and files outside `/workspace` and `/home/computer`, such as `/tmp`. Keep what must last in those two folders, or in an image of your own. Every computer's answer says the `version` of the program it runs.
- A container made before 0.0.17 keeps its home inside it. At its first remake the home is copied out. If that fails, the container is kept and started as it was, its `logs` say why, and the copy is tried again at its next start. Until it is made again, its `version` is `null`.

## Access

| `--access` | Tools at the `computer` endpoint                          |
| ---------- | --------------------------------------------------------- |
| `read`     | `about`, `read`, `list`, `search`                         |
| `files`    | Those, and `edit`                                         |
| `terminal` | Those, and `exec_command`, `write_stdin`, `list_sessions` |
| `none`     | No `computer` endpoint; needs `--browser`                 |

`read` answers a text file as numbered lines, and a PNG, JPEG, GIF or WebP of up to 3 MiB as the picture itself: an image an MCP client can pass on to a model. The browser's `browser_take_screenshot` answers an image too, but not one of more than 3 MiB, which a `fullPage` screenshot of a long page can be many times over: it answers an error that gives the size and says to take it again without `fullPage`, or of one element. The most counts bytes only: a model may still refuse a smaller picture for its height or width.

`about` tells the agent what a person looking at the computer reads. It takes nothing and answers JSON text, `{"rows": [...]}`, each row a `label` and a `value`, with `"path": true` on a value that is a path and `"caution": true` on one to be read as a caution; a row that is neither has neither. The rows come in this order:

| `label`     | `value`                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------- |
| `Where`     | The machine's own name                                                                    |
| `Folder`    | The workspace's path on that machine, as a path                                           |
| `Reaches`   | `Read-only files`, `Files`, or `Files and terminal`; with a browser, `, Browser` after it |
| `Isolation` | `None: it acts as you, on the whole machine`, as a caution, or `A container of its own`   |
| `Others acting` | Who else acted on it in the last 10 s, and on what: `The person: terminal s_…, the files`, or `Nobody` |
| `CPU`       | Used, of all the machine's CPUs, as a whole percentage: `37%`                             |
| `Memory`    | Used of the machine's total, counted in 1024s and written GB: `9.2 of 16 GB`              |
| `Disk`      | Used of total, of the volume the workspace is on, counted in 1000s: `212 of 494 GB`       |

- **In a container** the agent's commands find the folder somewhere else, so `Folder` says both and is not marked as a path: `/home/me/Research on the machine, mounted at /workspace in it`. CPU and Memory there are the computer's own; on this computer they are the whole machine's.
- **The last three** are a reading of its load taken over half a second when it is asked, in the same way the `load` surface reads. They come together, or not at all where a reading can't be taken.
- **Not every computer has it.** One with no `computer` endpoint has no `about`.

A client that calls a computer's tools can put the commands it starts in a group, and stop them together. At `--access terminal` it sends a word as `agentexec/group` in the `_meta` of an `exec_command` call, and the request `agentexec/group/stop` with `{"group": "<word>"}` on the `computer` endpoint, which ends every running command of that group and answers `{"stopped": <how many>}`. Giving up a call does not stop its command; only that request does. A shell a person opened is in no group. This is AgentExec's, described in [its README](https://github.com/uniac-ai/AgentExec#sessions), and the service passes both through, on this computer and in a container.

In a container the file tools stay inside the workspace, which is a check and not a boundary: the container is the boundary. On this computer they reach the whole machine. Below `terminal`, the browser's `browser_run_code_unsafe` tool is hidden and refused, because it would otherwise be a terminal. The browser's endpoint takes one JSON-RPC request in each POST, as a JSON object, and refuses anything else with 400, a batch among them: it checks each request before passing it on, and passes on only what it read. The service enforces all of this, whatever the client does.

Before 0.0.14 the browser's endpoint passed on a body it couldn't read as one request, unchecked. So on a computer made with `--access none`, `read` or `files` and `--browser`, a caller holding that computer's token could run code in its browser by sending the call in a batch or behind a byte order mark. It needed the computer's own token and a client that sends such a body, which MCP clients don't. 0.0.14 fixes it; a computer in a container made by an earlier version keeps the fault until its container is made again.

The browser has no debug port: a small host process starts it and shares it on a Unix socket in a folder only its user can enter, which the agent's tools and the live view both use. Playwright MCP, which serves the tools, listens on a Unix socket in a second such folder, and no port either. Only the service's user can reach them; callers go through the computer's `browser` endpoint and its token. It lives as long as its computer does: a client that ends its session or goes away leaves the browser and its pages as they are, and the agent's `browser_close` is refused. Only an agent with `--access terminal` can stop it, with `browser_run_code_unsafe` or from its terminal.

## Commands

|                                           |                                                                                                                                        |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `serve`                                   | Run the service: `--listen` (127.0.0.1:7878), `--data`                                                                                 |
| `up`, `down`, `status`                    | Run the service in the background, stop it, say where it is running                                                                    |
| `info`                                    | The service's version and what it offers: this computer, and the kinds it makes, each ready or not                                     |
| `create`                                  | Make a computer: `--access`, `--browser`, `--isolation`, `--workspace` or `--copy-from`, `--name`, `--timeout`, `--metadata KEY=VALUE` |
| `attach`                                  | Attach this computer: `--access`, `--workspace`, `--browser`, `--name`, `--timeout`, `--metadata KEY=VALUE`                            |
| `list [--state]`, `get <id>`, `logs <id>` | Look at them                                                                                                                           |
| `timeout <id> <seconds>`                  | It now stops this long from now                                                                                                        |
| `stop <id>`, `start <id> [--timeout]`     | Stop it, keeping its folder and token; start it again                                                                                  |
| `live <id> --surface [--mode]`            | A one-time ticket to open one of its surfaces live; see [Live sessions](#live-sessions)                                                |
| `kill <id>`                               | Stop it and remove what the service made; this computer, detach it                                                                     |

**In the background.** `up` takes what `serve` takes, runs the service in the background for you, and returns once it answers, printing its `url`, `pid` and version. If one already answers for the data folder it prints that one and starts nothing. `status` prints the same, or exits 1 with none running. `down` ends it and says nothing; its computers stop with it, and start again when it next does. `serve` won't run beside a service that already answers for the same data folder. `--version` prints the program's version, with no service.

- What the service writes goes to `service.log` in the data folder, of which `up` keeps the last 1 MiB.
- It stays when whatever started it goes, and nothing starts it when the machine does. To have it at login, a shell profile can run `agentcomputer up`; a supervisor such as launchd or a systemd user unit is given `agentcomputer serve`, which it keeps in the foreground.
- `up`, `down` and `status` are for a service on this machine that this machine can reach at its address.
- `start` and `stop` are a computer's and take its id. With the id left out they stop nothing, and say so.

Made with no `--workspace`, a computer has a folder the service makes, which goes when it is killed, unless it was made with no isolation by an earlier version. A folder you name is never deleted. A computer with a `--timeout` stops when it runs out, and its folder stays.

The service listens on loopback unless you give it TLS; see [Across a network](#across-a-network).

The data folder is `--data`, else `$AGENTCOMPUTER_DATA`, else `$XDG_DATA_HOME/agentcomputer`, else `~/.local/share/agentcomputer`. It holds `control-token` and `server.json`, which the commands read; a `server.json` left by a service that crashed names nothing, and is seen through.

## API

[`openapi.yaml`](openapi.yaml) defines every operation, and a running service publishes it at `/openapi.json`. The HTTP API and the MCP control tools are generated from it and answered by the same handlers, and the SDK's types come from it.

| Operation                                 | MCP tool at `/v1/mcp`  |
| ----------------------------------------- | ---------------------- |
| `GET /v1/info`                            | `service_info`         |
| `POST /v1/computers`                      | `computer_create`      |
| `POST /v1/computers/attach`               | `computer_attach`      |
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

`POST /v1/computers` and `POST /v1/computers/attach` are the only places an `accessToken` is shown. Failures are `{ "code": 404, "message": "..." }`.

## SDK

```ts
import { Computer } from "@agentorg/computer";

const computer = await Computer.create({ access: "terminal", browser: true, timeoutMs: 600_000 });
// Or this computer: await Computer.attach({ access: "terminal", workspace: "/home/me/work" });
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
  serve --data /srv/agentcomputer --listen 0.0.0.0:7878 \
  --tls-cert /srv/agentcomputer/cert.pem --tls-key /srv/agentcomputer/key.pem \
  --public-url https://computers.example.com:7878
```

- Its data folder, and any `--workspace`, have to be mounted at the same path inside as outside, because Docker reads those paths on the machine.
- `--network host` is how it reaches each computer's port on the machine's loopback, so this needs Linux.
- The socket gives it full control of that machine's Docker. Whoever holds the control token can make computers, but not reach the socket: a service that other machines reach doesn't offer this computer, which here is its own container.

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

Every running computer has two more, to watch only:

- **`load`** (protocol `metrics@1`): how busy it is. The service sends a reading every two seconds while a socket is open, the first two seconds after the first socket opens, and the last one at once to a socket that opens later: `{"type":"reading","scope":"machine","cpuUsedPct":37.2,"memUsed":…,"memTotal":…,"diskUsed":…,"diskTotal":…}`, in bytes. `openapi.yaml` has each field, as `LoadReading`.
  - **`scope` says whose numbers they are.** A computer in a container reads its own (`computer`), against the machine's totals, since a container has no limit of its own. This computer has no edge to measure at, so it reads the whole machine's (`machine`); so does a container that can't read its own.
  - **The disk is the volume its workspace is on,** not the workspace's own size.
  - **Nothing depends on it.** Nothing is read while nobody watches or asks, a reading that can't be taken is left out, and a socket that hasn't read the one before is not sent the next.
- **`presence`** (protocol `presence@1`): who is acting on it now, which is within the last 10 seconds, and on what. It sends `{"type":"presence","acting":[…]}` when it opens, and again each time someone starts or stops acting on something; `openapi.yaml` has each field, as `PresenceEvent`.
  - **Who:** the person, through a live view at operate (typing into a terminal, writing a file, using the browser), or the agent, by its computer's name (starting a command or typing into one, the file tools, the browser's tools). Watching is not acting.
  - **On what:** a terminal, by its id, the files, or the browser.
  - **The agent is told too.** `about` names who else is acting, and the answer to the agent's call on something the person acted on since its last call there ends with a line: `The person typed in this terminal 3 s ago.`, `The person changed files here 2 s ago.` or `The person used the browser 4 s ago.`
  - **Nothing is refused by it,** for the person or the agent.

`POST /v1/computers/{computerID}/live` with `{ "surface": "terminal", "mode": "operate" }` gives a ticket: a `url` to open once within a minute, which needs no token. A request with an `Origin` header is refused unless `serve --allow-origin` names that origin, so a page can't open one. The SDK does the same with `computer.terminals.connect({ onEvent })`, or gives the ticket alone with `computer.liveSession("files")` or `computer.liveSession("browser", "operate")`, and the CLI with `agentcomputer live <id> --surface terminal --mode operate`.

A shell of your own needs [node-pty](https://github.com/microsoft/node-pty), an optional dependency installed beside the program. It comes prebuilt for macOS. On Linux it's compiled at install, which npm only does when told: `npm install -g @agentorg/computer --allow-scripts=node-pty`, with a C++ toolchain. Without it, the agent's commands run and show as ever, and only `open` is refused, saying why. The computer image has it.

## Known limits

- A container has no CPU or memory limit, and its network is Docker's default, so it reaches the internet and anything else Docker's network does.
- In a container the browser runs without its own sandbox, which needs privileges a computer doesn't have. The container is the boundary.
- A browser that stops, or a container that ends by itself, shows the computer as `failed`, and what can no longer be opened live says so in `surfaces`. So does a computer that couldn't be brought back when the service started, for one in a container because Docker didn't answer; its `logs` say why. Stop the computer and start it again.
- A file being written through the `files` surface sits beside its path as `.agentexec-…` until its last part, where a listing, and the agent, can see it. It stays if the service dies meanwhile.

## Tests

`npm test` runs the built service through the official MCP client, and one scenario through HTTP, MCP, the SDK and the CLI that fails if any operation in the schema isn't reached by each. Set `AGENTCOMPUTER_TEST_IMAGE` to a built image (`npm run build`, then `docker build .`) to run the same suite on containers, and `AGENTCOMPUTER_TEST_SERVICE_IMAGE` to one from `Dockerfile.service` to run the service itself as a container, with `AGENTCOMPUTER_TEST_ROOT` naming a folder Docker can mount if the temporary one isn't. After changing `openapi.yaml`, `npm run generate` writes what comes from it; CI fails if that changes anything. Set `AGENTCOMPUTER_BROWSER_PATH` to a Chromium program, such as Playwright's headless shell, to run the browser tests that are skipped without it.

## Licence

Apache-2.0.

// Generated from openapi.yaml by scripts/generate.js. Don't edit.
export const OPENAPI = {
  "openapi": "3.1.0",
  "info": {
    "title": "AgentComputer",
    "version": "0.0.10",
    "description": "Computers for agents. This file is the source of truth: the HTTP API, the MCP control tools and the SDK are all generated from it. An operation with `x-mcp-tool` is also an MCP tool of that name.",
    "license": {
      "name": "Apache-2.0",
      "identifier": "Apache-2.0"
    }
  },
  "servers": [
    {
      "url": "http://127.0.0.1:7878",
      "description": "The default address of a service on this machine."
    }
  ],
  "security": [
    {
      "controlToken": []
    }
  ],
  "paths": {
    "/v1/info": {
      "get": {
        "operationId": "getInfo",
        "x-mcp-tool": "service_info",
        "summary": "What this service is and how it isolates its computers.",
        "responses": {
          "200": {
            "description": "The service.",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/ServiceInfo"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        }
      }
    },
    "/v1/computers": {
      "get": {
        "operationId": "listComputers",
        "x-mcp-tool": "computer_list",
        "summary": "List the computers.",
        "parameters": [
          {
            "name": "state",
            "in": "query",
            "description": "Only computers in this state.",
            "schema": {
              "$ref": "#/components/schemas/ComputerState"
            }
          }
        ],
        "responses": {
          "200": {
            "description": "The computers, newest first.",
            "content": {
              "application/json": {
                "schema": {
                  "type": "array",
                  "items": {
                    "$ref": "#/components/schemas/Computer"
                  }
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        }
      },
      "post": {
        "operationId": "createComputer",
        "x-mcp-tool": "computer_create",
        "summary": "Create a computer. It answers once the computer is running.",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/NewComputer"
              }
            }
          }
        },
        "responses": {
          "201": {
            "description": "The computer, with its access token, shown only now.",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/CreatedComputer"
                }
              }
            }
          },
          "400": {
            "$ref": "#/components/responses/Error"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        }
      }
    },
    "/v1/computers/{computerID}": {
      "parameters": [
        {
          "$ref": "#/components/parameters/computerID"
        }
      ],
      "get": {
        "operationId": "getComputer",
        "x-mcp-tool": "computer_get",
        "summary": "One computer, with how long it has run and the tools it offers.",
        "responses": {
          "200": {
            "description": "The computer.",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/ComputerDetail"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          },
          "404": {
            "$ref": "#/components/responses/Error"
          }
        }
      },
      "delete": {
        "operationId": "killComputer",
        "x-mcp-tool": "computer_kill",
        "summary": "Stop it for good and remove what the service made. A folder someone named stays.",
        "responses": {
          "204": {
            "description": "Gone."
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          },
          "404": {
            "$ref": "#/components/responses/Error"
          }
        }
      }
    },
    "/v1/computers/{computerID}/timeout": {
      "parameters": [
        {
          "$ref": "#/components/parameters/computerID"
        }
      ],
      "post": {
        "operationId": "setComputerTimeout",
        "x-mcp-tool": "computer_set_timeout",
        "summary": "It now stops this many seconds from now, replacing any earlier timeout.",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "additionalProperties": false,
                "required": [
                  "timeout"
                ],
                "properties": {
                  "timeout": {
                    "$ref": "#/components/schemas/Timeout"
                  }
                }
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "The computer.",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/Computer"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          },
          "404": {
            "$ref": "#/components/responses/Error"
          },
          "409": {
            "$ref": "#/components/responses/Error"
          }
        }
      }
    },
    "/v1/computers/{computerID}/stop": {
      "parameters": [
        {
          "$ref": "#/components/parameters/computerID"
        }
      ],
      "post": {
        "operationId": "stopComputer",
        "x-mcp-tool": "computer_stop",
        "summary": "Stop what it is running. Its folder and its token stay, and it can start again.",
        "responses": {
          "200": {
            "description": "The computer.",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/Computer"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          },
          "404": {
            "$ref": "#/components/responses/Error"
          }
        }
      }
    },
    "/v1/computers/{computerID}/start": {
      "parameters": [
        {
          "$ref": "#/components/parameters/computerID"
        }
      ],
      "post": {
        "operationId": "startComputer",
        "x-mcp-tool": "computer_start",
        "summary": "Start a stopped computer again, with the same token and folder.",
        "requestBody": {
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "timeout": {
                    "$ref": "#/components/schemas/Timeout"
                  }
                }
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "The computer.",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/Computer"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          },
          "404": {
            "$ref": "#/components/responses/Error"
          }
        }
      }
    },
    "/v1/computers/{computerID}/logs": {
      "parameters": [
        {
          "$ref": "#/components/parameters/computerID"
        }
      ],
      "get": {
        "operationId": "getComputerLogs",
        "x-mcp-tool": "computer_logs",
        "summary": "What its servers wrote, and each request it was sent.",
        "responses": {
          "200": {
            "description": "The logs.",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/ComputerLogs"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          },
          "404": {
            "$ref": "#/components/responses/Error"
          }
        }
      }
    },
    "/v1/computers/{computerID}/live": {
      "parameters": [
        {
          "$ref": "#/components/parameters/computerID"
        }
      ],
      "post": {
        "operationId": "createLiveSession",
        "x-mcp-tool": "computer_live",
        "summary": "A one-time ticket to watch or operate one of its surfaces live: its terminals, its files, its browser, or its load. Open its url as a WebSocket within 60 seconds.",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/NewLiveSession"
              }
            }
          }
        },
        "responses": {
          "201": {
            "description": "The ticket.",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/LiveSession"
                }
              }
            }
          },
          "400": {
            "$ref": "#/components/responses/Error"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          },
          "404": {
            "$ref": "#/components/responses/Error"
          },
          "409": {
            "$ref": "#/components/responses/Error"
          }
        }
      }
    },
    "/v1/live/{liveID}": {
      "parameters": [
        {
          "name": "liveID",
          "in": "path",
          "required": true,
          "schema": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          }
        }
      ],
      "get": {
        "operationId": "openLiveSession",
        "summary": "Open a live session as a WebSocket. The ticket in its path is its authority and works once, so it takes no token. A request with an Origin header is refused unless the service was told to allow that origin.",
        "security": [],
        "responses": {
          "101": {
            "description": "The socket",
            "in the session's protocol.": null
          },
          "403": {
            "$ref": "#/components/responses/Error"
          },
          "404": {
            "$ref": "#/components/responses/Error"
          },
          "426": {
            "$ref": "#/components/responses/Error"
          }
        }
      }
    }
  },
  "components": {
    "securitySchemes": {
      "controlToken": {
        "type": "http",
        "scheme": "bearer",
        "description": "The control token, for this API and the control MCP endpoint at `/v1/mcp`. A computer's own MCP endpoints, at `/v1/computers/{computerID}/mcp/computer` and `.../browser`, take that computer's access token and nothing else."
      }
    },
    "parameters": {
      "computerID": {
        "name": "computerID",
        "in": "path",
        "required": true,
        "schema": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        }
      }
    },
    "responses": {
      "Error": {
        "description": "It was refused.",
        "content": {
          "application/json": {
            "schema": {
              "$ref": "#/components/schemas/Error"
            }
          }
        }
      },
      "Unauthorized": {
        "description": "No valid token."
      }
    },
    "schemas": {
      "Error": {
        "type": "object",
        "required": [
          "code",
          "message"
        ],
        "properties": {
          "code": {
            "type": "integer"
          },
          "message": {
            "type": "string"
          }
        }
      },
      "Access": {
        "type": "string",
        "enum": [
          "none",
          "read",
          "files",
          "terminal"
        ],
        "description": "How far it reaches into files and commands, each level containing the one before: `read` has read, list and search; `files` adds edit; `terminal` adds exec_command, write_stdin and list_sessions. Below terminal, the browser's code-running tool is hidden."
      },
      "ComputerState": {
        "type": "string",
        "enum": [
          "running",
          "stopped",
          "failed"
        ]
      },
      "Timeout": {
        "type": "integer",
        "minimum": 1,
        "description": "Seconds from now until the computer stops."
      },
      "Metadata": {
        "type": "object",
        "additionalProperties": {
          "type": "string",
          "maxLength": 1024
        },
        "maxProperties": 64,
        "description": "Your own labels, kept and returned as given."
      },
      "NewComputer": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "access"
        ],
        "properties": {
          "name": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "access": {
            "$ref": "#/components/schemas/Access"
          },
          "browser": {
            "type": "boolean",
            "default": false,
            "description": "Whether it has a browser. With access none, it must."
          },
          "workspace": {
            "type": "string",
            "maxLength": 4096,
            "description": "The full path of a folder that exists, on the service's machine. With none, the service makes a folder, which goes when the computer is killed. A folder named here never does."
          },
          "timeout": {
            "$ref": "#/components/schemas/Timeout"
          },
          "metadata": {
            "$ref": "#/components/schemas/Metadata"
          }
        }
      },
      "Endpoints": {
        "type": "object",
        "required": [
          "computer",
          "browser"
        ],
        "description": "MCP over Streamable HTTP, each taking the computer's access token as a bearer.",
        "properties": {
          "computer": {
            "type": [
              "string",
              "null"
            ],
            "description": "The terminal and files."
          },
          "browser": {
            "type": [
              "string",
              "null"
            ],
            "description": "The browser."
          }
        }
      },
      "Computer": {
        "type": "object",
        "required": [
          "computerID",
          "name",
          "state",
          "access",
          "browser",
          "workspace",
          "startedAt",
          "endAt",
          "metadata",
          "endpoints"
        ],
        "properties": {
          "computerID": {
            "type": "string"
          },
          "name": {
            "type": "string"
          },
          "state": {
            "$ref": "#/components/schemas/ComputerState"
          },
          "access": {
            "$ref": "#/components/schemas/Access"
          },
          "browser": {
            "type": "boolean"
          },
          "workspace": {
            "type": [
              "string",
              "null"
            ]
          },
          "startedAt": {
            "type": "string",
            "format": "date-time",
            "description": "When it last started."
          },
          "endAt": {
            "type": [
              "string",
              "null"
            ],
            "format": "date-time",
            "description": "When it will stop; null if it has no timeout."
          },
          "metadata": {
            "$ref": "#/components/schemas/Metadata"
          },
          "endpoints": {
            "$ref": "#/components/schemas/Endpoints"
          }
        }
      },
      "CreatedComputer": {
        "allOf": [
          {
            "$ref": "#/components/schemas/Computer"
          },
          {
            "type": "object",
            "required": [
              "accessToken"
            ],
            "properties": {
              "accessToken": {
                "type": "string",
                "description": "Good only for this computer's endpoints. Shown only now."
              }
            }
          }
        ]
      },
      "ComputerDetail": {
        "allOf": [
          {
            "$ref": "#/components/schemas/Computer"
          },
          {
            "type": "object",
            "required": [
              "uptimeSeconds",
              "tools",
              "surfaces"
            ],
            "properties": {
              "uptimeSeconds": {
                "type": "integer"
              },
              "surfaces": {
                "type": "array",
                "description": "What can be opened live while it runs.",
                "items": {
                  "$ref": "#/components/schemas/SurfaceInfo"
                }
              },
              "tools": {
                "type": "object",
                "required": [
                  "computer",
                  "browser"
                ],
                "properties": {
                  "computer": {
                    "type": "array",
                    "items": {
                      "type": "string"
                    }
                  },
                  "browser": {
                    "type": "array",
                    "items": {
                      "type": "string"
                    }
                  }
                }
              }
            }
          }
        ]
      },
      "Surface": {
        "type": "string",
        "enum": [
          "terminal",
          "files",
          "browser",
          "load"
        ],
        "description": "terminal: every terminal on it, the agent's commands and a person's shells alike, on one socket in terminal@1: text messages are TerminalEvent one way and TerminalInput the other. Watching reads them all; operating also opens a shell, types into any of them, the agent's included, sizes and stops them. files: its workspace's files, in files@1: text messages are FilesRequest one way and FilesAnswer the other, and a file's bytes travel as binary messages of at most 1,048,576 bytes. Watching lists and reads; operating also writes, which a computer with read access doesn't offer. browser: its browser, in screencast@1: binary messages are JPEG frames of the page shown, text messages are ScreencastEvent one way and ScreencastInput the other. Nobody waits for anybody: the agent's tools and a person's input act on the same browser at once. The page shown is each socket's own. A socket is shown each new tab as it opens, until it sends a tab input to show or open one; from then its page changes only when that page closes. load: how busy it is, in metrics@1, to watch only: a LoadReading every two seconds while a socket is open, the first two seconds after the first socket opens, and the last one at once to a socket that opens later. One that can't be taken is left out, and a socket that hasn't read the one before is not sent the next. Nothing is read while nobody watches."
      },
      "LiveMode": {
        "type": "string",
        "enum": [
          "watch",
          "operate"
        ],
        "description": "In watch you see and don't act: what you send is dropped, except that a files socket may still ask to list, to read and for what changed."
      },
      "SurfaceInfo": {
        "type": "object",
        "required": [
          "surface",
          "protocol",
          "operate"
        ],
        "properties": {
          "surface": {
            "$ref": "#/components/schemas/Surface"
          },
          "protocol": {
            "type": "string"
          },
          "operate": {
            "type": "boolean",
            "description": "Whether it can be operated",
            "not only watched.": null
          },
          "unavailable": {
            "type": "string",
            "description": "Why it can't be opened now, if it can't."
          }
        }
      },
      "NewLiveSession": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "surface"
        ],
        "properties": {
          "surface": {
            "$ref": "#/components/schemas/Surface"
          },
          "mode": {
            "allOf": [
              {
                "$ref": "#/components/schemas/LiveMode"
              }
            ],
            "default": "watch"
          }
        }
      },
      "LiveSession": {
        "type": "object",
        "required": [
          "url",
          "protocol",
          "surface",
          "mode",
          "expiresAt"
        ],
        "properties": {
          "url": {
            "type": "string",
            "description": "The WebSocket to open",
            "once.": null
          },
          "protocol": {
            "type": "string"
          },
          "surface": {
            "$ref": "#/components/schemas/Surface"
          },
          "mode": {
            "$ref": "#/components/schemas/LiveMode"
          },
          "expiresAt": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "ScreencastEvent": {
        "description": "What the service sends on a screencast@1 socket, as JSON text.",
        "oneOf": [
          {
            "type": "object",
            "description": "The open tabs, and which one this socket's frames are of, sent again whenever a tab opens, closes, navigates or changes its title, or the socket is shown another.",
            "required": [
              "type",
              "tabs",
              "shown"
            ],
            "properties": {
              "type": {
                "const": "tabs"
              },
              "tabs": {
                "type": "array",
                "items": {
                  "type": "object",
                  "required": [
                    "id",
                    "url",
                    "title"
                  ],
                  "properties": {
                    "id": {
                      "type": "integer"
                    },
                    "url": {
                      "type": "string"
                    },
                    "title": {
                      "type": "string"
                    }
                  }
                }
              },
              "shown": {
                "type": [
                  "integer",
                  "null"
                ]
              }
            }
          },
          {
            "type": "object",
            "description": "The size of the page in the frames, in the coordinates input uses.",
            "required": [
              "type",
              "width",
              "height"
            ],
            "properties": {
              "type": {
                "const": "viewport"
              },
              "width": {
                "type": "integer"
              },
              "height": {
                "type": "integer"
              }
            }
          },
          {
            "type": "object",
            "description": "A dialog the page opened, which blocks it until it's answered, or that it closed.",
            "required": [
              "type",
              "open"
            ],
            "properties": {
              "type": {
                "const": "dialog"
              },
              "open": {
                "type": "boolean"
              },
              "kind": {
                "type": "string",
                "enum": [
                  "alert",
                  "confirm",
                  "prompt",
                  "beforeunload"
                ]
              },
              "message": {
                "type": "string"
              },
              "defaultValue": {
                "type": "string"
              }
            }
          },
          {
            "type": "object",
            "description": "The page asked for files, or stopped asking.",
            "required": [
              "type",
              "open"
            ],
            "properties": {
              "type": {
                "const": "file-chooser"
              },
              "open": {
                "type": "boolean"
              },
              "multiple": {
                "type": "boolean"
              }
            }
          },
          {
            "type": "object",
            "description": "A list to choose from, after a press on one: a page's own list isn't in the frames.",
            "required": [
              "type",
              "multiple",
              "options"
            ],
            "properties": {
              "type": {
                "const": "choice"
              },
              "multiple": {
                "type": "boolean"
              },
              "options": {
                "type": "array",
                "items": {
                  "type": "object",
                  "required": [
                    "value",
                    "label",
                    "selected"
                  ],
                  "properties": {
                    "value": {
                      "type": "string"
                    },
                    "label": {
                      "type": "string"
                    },
                    "selected": {
                      "type": "boolean"
                    }
                  }
                }
              }
            }
          }
        ]
      },
      "ScreencastInput": {
        "description": "What an operate socket sends on screencast@1, as JSON text. A watch socket's is dropped.",
        "oneOf": [
          {
            "type": "object",
            "required": [
              "type",
              "action",
              "x",
              "y"
            ],
            "properties": {
              "type": {
                "const": "mouse"
              },
              "action": {
                "type": "string",
                "enum": [
                  "move",
                  "down",
                  "up",
                  "wheel"
                ]
              },
              "x": {
                "type": "number"
              },
              "y": {
                "type": "number"
              },
              "button": {
                "type": "string",
                "enum": [
                  "left",
                  "right",
                  "middle"
                ]
              },
              "deltaX": {
                "type": "number"
              },
              "deltaY": {
                "type": "number"
              }
            }
          },
          {
            "type": "object",
            "required": [
              "type",
              "action",
              "key"
            ],
            "properties": {
              "type": {
                "const": "key"
              },
              "action": {
                "type": "string",
                "enum": [
                  "down",
                  "up"
                ]
              },
              "key": {
                "type": "string",
                "description": "A key name",
                "as Playwright's keyboard takes it.": null
              }
            }
          },
          {
            "type": "object",
            "required": [
              "type",
              "text"
            ],
            "properties": {
              "type": {
                "const": "text"
              },
              "text": {
                "type": "string"
              }
            }
          },
          {
            "type": "object",
            "required": [
              "type",
              "accept"
            ],
            "properties": {
              "type": {
                "const": "dialog"
              },
              "accept": {
                "type": "boolean"
              },
              "text": {
                "type": "string"
              }
            }
          },
          {
            "type": "object",
            "description": "The files for an open file chooser. None cancels it.",
            "required": [
              "type",
              "files"
            ],
            "properties": {
              "type": {
                "const": "files"
              },
              "files": {
                "type": "array",
                "items": {
                  "type": "object",
                  "required": [
                    "name",
                    "data"
                  ],
                  "properties": {
                    "name": {
                      "type": "string"
                    },
                    "mimeType": {
                      "type": "string"
                    },
                    "data": {
                      "type": "string",
                      "description": "Base64."
                    }
                  }
                }
              }
            }
          },
          {
            "type": "object",
            "required": [
              "type",
              "values"
            ],
            "properties": {
              "type": {
                "const": "choice"
              },
              "values": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              }
            }
          },
          {
            "type": "object",
            "description": "Show this socket another tab, open one and show it, or close one. After show or open, the socket's page is its own and no longer follows new tabs.",
            "required": [
              "type",
              "action"
            ],
            "properties": {
              "type": {
                "const": "tab"
              },
              "action": {
                "type": "string",
                "enum": [
                  "show",
                  "open",
                  "close"
                ]
              },
              "id": {
                "type": "integer"
              },
              "url": {
                "type": "string"
              }
            }
          },
          {
            "type": "object",
            "required": [
              "type",
              "to"
            ],
            "properties": {
              "type": {
                "const": "navigate"
              },
              "to": {
                "type": "string",
                "description": "A URL, or back, forward or reload."
              }
            }
          }
        ]
      },
      "TerminalEvent": {
        "description": "What the service sends on a terminal@1 socket, as JSON text, no message over 65,536 bytes. A terminal is a command the agent started or a shell a person opened; its id is the session id the agent's tools use. A new socket is first sent, for each terminal already there, the oldest first, its start, the end of what it wrote (its last 65,536 characters), and its exit if it has ended; then each event as it happens, with nothing to mark where the first ends. The last 64 that ended are among those already there, and one that leaves that list is not told. A character here is a UTF-16 unit. A socket with more than 4 MiB still to be sent to it is closed, with no close frame (1006): one that has stopped reading, or one that is reading while a terminal writes tens of megabytes at once. It isn't an error. Opened again, it is sent every terminal afresh, with the last 65,536 characters each wrote, in place of whatever it held.",
        "oneOf": [
          {
            "type": "object",
            "description": "A terminal began.",
            "required": [
              "type",
              "id",
              "by",
              "cmd",
              "workdir",
              "tty",
              "at"
            ],
            "properties": {
              "type": {
                "const": "start"
              },
              "id": {
                "type": "string"
              },
              "by": {
                "type": "string",
                "enum": [
                  "agent",
                  "person"
                ],
                "description": "The way in it came: agent through a tool, person through this surface."
              },
              "cmd": {
                "type": "string",
                "description": "Its command, the first 8,000 characters of it."
              },
              "workdir": {
                "type": "string",
                "description": "Its folder, the first 2,000 characters of it."
              },
              "tty": {
                "type": "boolean",
                "description": "Whether it is on a terminal device, as a person's shell is. One that isn't, as the agent's commands aren't, echoes nothing typed into it and wants a line feed for Enter. Nothing tells the size of one that is."
              },
              "at": {
                "type": "string",
                "format": "date-time"
              }
            }
          },
          {
            "type": "object",
            "description": "What it wrote, as it writes: 10,000 characters a message at most, a longer piece as several. A command that left something running can still write after its exit.",
            "required": [
              "type",
              "id",
              "text"
            ],
            "properties": {
              "type": {
                "const": "output"
              },
              "id": {
                "type": "string"
              },
              "stream": {
                "type": "string",
                "enum": [
                  "stdout",
                  "stderr"
                ],
                "description": "Left out for one on a terminal device, which has one stream, and in what a new socket is first sent, where the two are one text."
              },
              "text": {
                "type": "string"
              }
            }
          },
          {
            "type": "object",
            "description": "It ended.",
            "required": [
              "type",
              "id",
              "exitCode",
              "at"
            ],
            "properties": {
              "type": {
                "const": "exit"
              },
              "id": {
                "type": "string"
              },
              "exitCode": {
                "type": "integer"
              },
              "at": {
                "type": "string",
                "format": "date-time"
              }
            }
          },
          {
            "type": "object",
            "description": "What this socket asked wasn't done, and why, in words for a person. Sent only to the operate socket that asked. What was done is answered by its event, or by nothing.",
            "required": [
              "type",
              "message"
            ],
            "properties": {
              "type": {
                "const": "refused"
              },
              "message": {
                "type": "string"
              }
            }
          }
        ]
      },
      "TerminalInput": {
        "description": "What an operate socket sends on terminal@1, as JSON text. One that can't be done, or that is none of these, is answered with refused. What a watch socket sends is dropped. A message over 65,536 bytes closes the socket, so a long text goes as several inputs.",
        "oneOf": [
          {
            "type": "object",
            "description": "Start a shell of your own in the workspace, as its user, on a terminal device of this size. It arrives as a start like any other. Refused past the 64 terminals that may run at once, and where the service has no node-pty.",
            "required": [
              "type",
              "columns",
              "rows"
            ],
            "properties": {
              "type": {
                "const": "open"
              },
              "columns": {
                "type": "integer",
                "minimum": 1,
                "maximum": 1000
              },
              "rows": {
                "type": "integer",
                "minimum": 1,
                "maximum": 1000
              }
            }
          },
          {
            "type": "object",
            "description": "Type into a running terminal, the agent's included. In a command, Ctrl-C (U+0003) interrupts it and Ctrl-D (U+0004) ends its input. Refused for one that has ended or isn't there.",
            "required": [
              "type",
              "id",
              "text"
            ],
            "properties": {
              "type": {
                "const": "input"
              },
              "id": {
                "type": "string"
              },
              "text": {
                "type": "string"
              }
            }
          },
          {
            "type": "object",
            "description": "Give a terminal on a terminal device a new size, which is the size for everyone looking at it. Refused for a command, which has none, and for one that has ended or isn't there.",
            "required": [
              "type",
              "id",
              "columns",
              "rows"
            ],
            "properties": {
              "type": {
                "const": "resize"
              },
              "id": {
                "type": "string"
              },
              "columns": {
                "type": "integer",
                "minimum": 1,
                "maximum": 1000
              },
              "rows": {
                "type": "integer",
                "minimum": 1,
                "maximum": 1000
              }
            }
          },
          {
            "type": "object",
            "description": "End a terminal: an interrupt for a command, a hangup for a shell, then a kill a second later. Its exit is the answer. One that has ended is left as it is, and one that isn't there is refused.",
            "required": [
              "type",
              "id"
            ],
            "properties": {
              "type": {
                "const": "stop"
              },
              "id": {
                "type": "string"
              }
            }
          }
        ]
      },
      "LoadReading": {
        "description": "What the service sends on a metrics@1 socket, as JSON text. What a socket sends is dropped.",
        "type": "object",
        "required": [
          "type",
          "scope",
          "cpuUsedPct",
          "memUsed",
          "memTotal",
          "diskUsed",
          "diskTotal"
        ],
        "properties": {
          "type": {
            "const": "reading"
          },
          "scope": {
            "type": "string",
            "enum": [
              "computer",
              "machine"
            ],
            "description": "Whose numbers these are. computer: this computer's own, which a container's are. machine: the whole machine's, which a computer with no isolation shares with whatever else runs there, so every computer of that service reads the same; and a container's where it can't read its own."
          },
          "cpuUsedPct": {
            "type": "number",
            "minimum": 0,
            "maximum": 100,
            "description": "Of all the machine's CPUs, since the reading before. One decimal."
          },
          "memUsed": {
            "type": "integer",
            "description": "Bytes in use."
          },
          "memTotal": {
            "type": "integer",
            "description": "Bytes the machine has: no computer has a limit."
          },
          "diskUsed": {
            "type": "integer",
            "description": "Bytes used on the volume its workspace is on, or its own folder where it has no workspace. The volume's, not the workspace's own size."
          },
          "diskTotal": {
            "type": "integer",
            "description": "Bytes on that volume."
          }
        }
      },
      "FilesRequest": {
        "description": "What a socket sends on files@1, as JSON text. Each has an id of its own choosing, which the answer repeats; answers come as they are ready, in any order, and ids aren't checked for repeats. A request still unanswered when the socket closes gets no answer. A path is from the workspace, with / between its parts, or absolute inside it, and nothing outside the workspace is reached. A binary message that follows no write closes the socket, and so does any message over 1,048,576 bytes.",
        "oneOf": [
          {
            "type": "object",
            "description": "A folder's entries, folders first, the first thousand. There is no asking for the rest.",
            "required": [
              "type",
              "id"
            ],
            "properties": {
              "type": {
                "const": "list"
              },
              "id": {
                "type": "string",
                "minLength": 1,
                "maxLength": 64
              },
              "path": {
                "type": "string",
                "description": "The workspace itself, if left out."
              }
            }
          },
          {
            "type": "object",
            "description": "Bytes of a file from an offset. The answer is a data message and then one binary message, the bytes: fewer than asked for at the file's end, and none past it.",
            "required": [
              "type",
              "id",
              "path",
              "offset",
              "length"
            ],
            "properties": {
              "type": {
                "const": "read"
              },
              "id": {
                "type": "string",
                "minLength": 1,
                "maxLength": 64
              },
              "path": {
                "type": "string"
              },
              "offset": {
                "type": "integer",
                "minimum": 0
              },
              "length": {
                "type": "integer",
                "minimum": 1,
                "maximum": 1048576
              }
            }
          },
          {
            "type": "object",
            "description": "The files modified after a time, in whole milliseconds: the newest thousand, the newest first. It skips what .gitignore files ignore, .git, node_modules and links, and a file that was removed isn't one of them. Each one asked walks the workspace once, and a computer walks for one at a time. Nothing is walked that wasn't asked for.",
            "required": [
              "type",
              "id",
              "since"
            ],
            "properties": {
              "type": {
                "const": "changed"
              },
              "id": {
                "type": "string",
                "minLength": 1,
                "maxLength": 64
              },
              "since": {
                "type": "string",
                "format": "date-time"
              }
            }
          },
          {
            "type": "object",
            "description": "The next part of a file, on an operate socket, followed by one binary message of exactly length bytes, with no message between them. The part at offset 0 starts the file, or starts it again, and each one after starts where the last ended. Nothing is at the path until the part marked last, which puts the file there whole, over any that was there, and is answered with written. Only that part, and a part that is refused, is answered. It makes no folders. A file not finished when the socket closes is given up.",
            "required": [
              "type",
              "id",
              "path",
              "offset",
              "length",
              "last"
            ],
            "properties": {
              "type": {
                "const": "write"
              },
              "id": {
                "type": "string",
                "minLength": 1,
                "maxLength": 64
              },
              "path": {
                "type": "string"
              },
              "offset": {
                "type": "integer",
                "minimum": 0
              },
              "length": {
                "type": "integer",
                "minimum": 0,
                "maximum": 1048576
              },
              "last": {
                "type": "boolean"
              }
            }
          }
        ]
      },
      "FilesAnswer": {
        "description": "What the service sends on files@1, as JSON text, each with the id it answers. Nothing comes between a data message and its bytes.",
        "oneOf": [
          {
            "type": "object",
            "required": [
              "type",
              "id",
              "path",
              "entries",
              "more"
            ],
            "properties": {
              "type": {
                "const": "entries"
              },
              "id": {
                "type": "string"
              },
              "path": {
                "type": "string"
              },
              "entries": {
                "type": "array",
                "items": {
                  "type": "object",
                  "description": "A link is not followed, and its size and date are its own.",
                  "required": [
                    "name",
                    "kind",
                    "size",
                    "modifiedAt"
                  ],
                  "properties": {
                    "name": {
                      "type": "string"
                    },
                    "kind": {
                      "type": "string",
                      "enum": [
                        "file",
                        "folder",
                        "link"
                      ]
                    },
                    "size": {
                      "type": "integer"
                    },
                    "modifiedAt": {
                      "type": "string",
                      "format": "date-time"
                    }
                  }
                }
              },
              "more": {
                "type": "boolean",
                "description": "Whether the folder has more than these."
              }
            }
          },
          {
            "type": "object",
            "description": "What the binary message after it is, and the file's whole size and date.",
            "required": [
              "type",
              "id",
              "path",
              "offset",
              "length",
              "size",
              "modifiedAt"
            ],
            "properties": {
              "type": {
                "const": "data"
              },
              "id": {
                "type": "string"
              },
              "path": {
                "type": "string"
              },
              "offset": {
                "type": "integer"
              },
              "length": {
                "type": "integer",
                "description": "How many bytes follow."
              },
              "size": {
                "type": "integer"
              },
              "modifiedAt": {
                "type": "string",
                "format": "date-time"
              }
            }
          },
          {
            "type": "object",
            "required": [
              "type",
              "id",
              "since",
              "changes",
              "more"
            ],
            "properties": {
              "type": {
                "const": "changes"
              },
              "id": {
                "type": "string"
              },
              "since": {
                "type": "string",
                "format": "date-time"
              },
              "changes": {
                "type": "array",
                "items": {
                  "type": "object",
                  "required": [
                    "path",
                    "size",
                    "modifiedAt"
                  ],
                  "properties": {
                    "path": {
                      "type": "string"
                    },
                    "size": {
                      "type": "integer"
                    },
                    "modifiedAt": {
                      "type": "string",
                      "format": "date-time"
                    }
                  }
                }
              },
              "more": {
                "type": "boolean",
                "description": "Whether more than these changed."
              }
            }
          },
          {
            "type": "object",
            "description": "The file is in place.",
            "required": [
              "type",
              "id",
              "path",
              "size"
            ],
            "properties": {
              "type": {
                "const": "written"
              },
              "id": {
                "type": "string"
              },
              "path": {
                "type": "string"
              },
              "size": {
                "type": "integer"
              }
            }
          },
          {
            "type": "object",
            "description": "It wasn't done, and why. The id is empty when what was sent had none to repeat.",
            "required": [
              "type",
              "id",
              "message"
            ],
            "properties": {
              "type": {
                "const": "refused"
              },
              "id": {
                "type": "string"
              },
              "message": {
                "type": "string"
              }
            }
          }
        ]
      },
      "ComputerLogs": {
        "type": "object",
        "required": [
          "logs"
        ],
        "properties": {
          "logs": {
            "type": "array",
            "items": {
              "type": "object",
              "required": [
                "timestamp",
                "line"
              ],
              "properties": {
                "timestamp": {
                  "type": "string",
                  "format": "date-time"
                },
                "line": {
                  "type": "string"
                }
              }
            }
          }
        }
      },
      "ServiceInfo": {
        "type": "object",
        "required": [
          "version",
          "isolation"
        ],
        "properties": {
          "version": {
            "type": "string"
          },
          "isolation": {
            "type": "string",
            "enum": [
              "none",
              "container"
            ],
            "description": "How this service isolates its computers, chosen when it is started."
          }
        }
      }
    }
  }
} as const;

export interface Operation {
  operationId: string;
  method: string;
  path: string;
  /** Absent where the operation isn't a tool, as a WebSocket isn't. */
  tool?: string;
  summary: string;
  status: number;
  hasBody: boolean;
  pathParameters: string[];
  queryParameters: string[];
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  websocket: boolean;
}

export const OPERATIONS: Operation[] = [
  {
    "operationId": "getInfo",
    "method": "GET",
    "path": "/v1/info",
    "tool": "service_info",
    "summary": "What this service is and how it isolates its computers.",
    "status": 200,
    "hasBody": false,
    "pathParameters": [],
    "queryParameters": [],
    "input": {
      "type": "object",
      "additionalProperties": false,
      "properties": {},
      "required": []
    },
    "output": {
      "type": "object",
      "required": [
        "version",
        "isolation"
      ],
      "properties": {
        "version": {
          "type": "string"
        },
        "isolation": {
          "type": "string",
          "enum": [
            "none",
            "container"
          ],
          "description": "How this service isolates its computers, chosen when it is started."
        }
      }
    },
    "websocket": false
  },
  {
    "operationId": "listComputers",
    "method": "GET",
    "path": "/v1/computers",
    "tool": "computer_list",
    "summary": "List the computers.",
    "status": 200,
    "hasBody": false,
    "pathParameters": [],
    "queryParameters": [
      "state"
    ],
    "input": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "state": {
          "type": "string",
          "enum": [
            "running",
            "stopped",
            "failed"
          ]
        }
      },
      "required": []
    },
    "output": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "computerID",
          "name",
          "state",
          "access",
          "browser",
          "workspace",
          "startedAt",
          "endAt",
          "metadata",
          "endpoints"
        ],
        "properties": {
          "computerID": {
            "type": "string"
          },
          "name": {
            "type": "string"
          },
          "state": {
            "type": "string",
            "enum": [
              "running",
              "stopped",
              "failed"
            ]
          },
          "access": {
            "type": "string",
            "enum": [
              "none",
              "read",
              "files",
              "terminal"
            ],
            "description": "How far it reaches into files and commands, each level containing the one before: `read` has read, list and search; `files` adds edit; `terminal` adds exec_command, write_stdin and list_sessions. Below terminal, the browser's code-running tool is hidden."
          },
          "browser": {
            "type": "boolean"
          },
          "workspace": {
            "type": [
              "string",
              "null"
            ]
          },
          "startedAt": {
            "type": "string",
            "format": "date-time",
            "description": "When it last started."
          },
          "endAt": {
            "type": [
              "string",
              "null"
            ],
            "format": "date-time",
            "description": "When it will stop; null if it has no timeout."
          },
          "metadata": {
            "type": "object",
            "additionalProperties": {
              "type": "string",
              "maxLength": 1024
            },
            "maxProperties": 64,
            "description": "Your own labels, kept and returned as given."
          },
          "endpoints": {
            "type": "object",
            "required": [
              "computer",
              "browser"
            ],
            "description": "MCP over Streamable HTTP, each taking the computer's access token as a bearer.",
            "properties": {
              "computer": {
                "type": [
                  "string",
                  "null"
                ],
                "description": "The terminal and files."
              },
              "browser": {
                "type": [
                  "string",
                  "null"
                ],
                "description": "The browser."
              }
            }
          }
        }
      }
    },
    "websocket": false
  },
  {
    "operationId": "createComputer",
    "method": "POST",
    "path": "/v1/computers",
    "tool": "computer_create",
    "summary": "Create a computer. It answers once the computer is running.",
    "status": 201,
    "hasBody": true,
    "pathParameters": [],
    "queryParameters": [],
    "input": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "access": {
          "type": "string",
          "enum": [
            "none",
            "read",
            "files",
            "terminal"
          ],
          "description": "How far it reaches into files and commands, each level containing the one before: `read` has read, list and search; `files` adds edit; `terminal` adds exec_command, write_stdin and list_sessions. Below terminal, the browser's code-running tool is hidden."
        },
        "browser": {
          "type": "boolean",
          "default": false,
          "description": "Whether it has a browser. With access none, it must."
        },
        "workspace": {
          "type": "string",
          "maxLength": 4096,
          "description": "The full path of a folder that exists, on the service's machine. With none, the service makes a folder, which goes when the computer is killed. A folder named here never does."
        },
        "timeout": {
          "type": "integer",
          "minimum": 1,
          "description": "Seconds from now until the computer stops."
        },
        "metadata": {
          "type": "object",
          "additionalProperties": {
            "type": "string",
            "maxLength": 1024
          },
          "maxProperties": 64,
          "description": "Your own labels, kept and returned as given."
        }
      },
      "required": [
        "access"
      ]
    },
    "output": {
      "allOf": [
        {
          "type": "object",
          "required": [
            "computerID",
            "name",
            "state",
            "access",
            "browser",
            "workspace",
            "startedAt",
            "endAt",
            "metadata",
            "endpoints"
          ],
          "properties": {
            "computerID": {
              "type": "string"
            },
            "name": {
              "type": "string"
            },
            "state": {
              "type": "string",
              "enum": [
                "running",
                "stopped",
                "failed"
              ]
            },
            "access": {
              "type": "string",
              "enum": [
                "none",
                "read",
                "files",
                "terminal"
              ],
              "description": "How far it reaches into files and commands, each level containing the one before: `read` has read, list and search; `files` adds edit; `terminal` adds exec_command, write_stdin and list_sessions. Below terminal, the browser's code-running tool is hidden."
            },
            "browser": {
              "type": "boolean"
            },
            "workspace": {
              "type": [
                "string",
                "null"
              ]
            },
            "startedAt": {
              "type": "string",
              "format": "date-time",
              "description": "When it last started."
            },
            "endAt": {
              "type": [
                "string",
                "null"
              ],
              "format": "date-time",
              "description": "When it will stop; null if it has no timeout."
            },
            "metadata": {
              "type": "object",
              "additionalProperties": {
                "type": "string",
                "maxLength": 1024
              },
              "maxProperties": 64,
              "description": "Your own labels, kept and returned as given."
            },
            "endpoints": {
              "type": "object",
              "required": [
                "computer",
                "browser"
              ],
              "description": "MCP over Streamable HTTP, each taking the computer's access token as a bearer.",
              "properties": {
                "computer": {
                  "type": [
                    "string",
                    "null"
                  ],
                  "description": "The terminal and files."
                },
                "browser": {
                  "type": [
                    "string",
                    "null"
                  ],
                  "description": "The browser."
                }
              }
            }
          }
        },
        {
          "type": "object",
          "required": [
            "accessToken"
          ],
          "properties": {
            "accessToken": {
              "type": "string",
              "description": "Good only for this computer's endpoints. Shown only now."
            }
          }
        }
      ]
    },
    "websocket": false
  },
  {
    "operationId": "getComputer",
    "method": "GET",
    "path": "/v1/computers/{computerID}",
    "tool": "computer_get",
    "summary": "One computer, with how long it has run and the tools it offers.",
    "status": 200,
    "hasBody": false,
    "pathParameters": [
      "computerID"
    ],
    "queryParameters": [],
    "input": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "computerID": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "computerID"
      ]
    },
    "output": {
      "allOf": [
        {
          "type": "object",
          "required": [
            "computerID",
            "name",
            "state",
            "access",
            "browser",
            "workspace",
            "startedAt",
            "endAt",
            "metadata",
            "endpoints"
          ],
          "properties": {
            "computerID": {
              "type": "string"
            },
            "name": {
              "type": "string"
            },
            "state": {
              "type": "string",
              "enum": [
                "running",
                "stopped",
                "failed"
              ]
            },
            "access": {
              "type": "string",
              "enum": [
                "none",
                "read",
                "files",
                "terminal"
              ],
              "description": "How far it reaches into files and commands, each level containing the one before: `read` has read, list and search; `files` adds edit; `terminal` adds exec_command, write_stdin and list_sessions. Below terminal, the browser's code-running tool is hidden."
            },
            "browser": {
              "type": "boolean"
            },
            "workspace": {
              "type": [
                "string",
                "null"
              ]
            },
            "startedAt": {
              "type": "string",
              "format": "date-time",
              "description": "When it last started."
            },
            "endAt": {
              "type": [
                "string",
                "null"
              ],
              "format": "date-time",
              "description": "When it will stop; null if it has no timeout."
            },
            "metadata": {
              "type": "object",
              "additionalProperties": {
                "type": "string",
                "maxLength": 1024
              },
              "maxProperties": 64,
              "description": "Your own labels, kept and returned as given."
            },
            "endpoints": {
              "type": "object",
              "required": [
                "computer",
                "browser"
              ],
              "description": "MCP over Streamable HTTP, each taking the computer's access token as a bearer.",
              "properties": {
                "computer": {
                  "type": [
                    "string",
                    "null"
                  ],
                  "description": "The terminal and files."
                },
                "browser": {
                  "type": [
                    "string",
                    "null"
                  ],
                  "description": "The browser."
                }
              }
            }
          }
        },
        {
          "type": "object",
          "required": [
            "uptimeSeconds",
            "tools",
            "surfaces"
          ],
          "properties": {
            "uptimeSeconds": {
              "type": "integer"
            },
            "surfaces": {
              "type": "array",
              "description": "What can be opened live while it runs.",
              "items": {
                "type": "object",
                "required": [
                  "surface",
                  "protocol",
                  "operate"
                ],
                "properties": {
                  "surface": {
                    "type": "string",
                    "enum": [
                      "terminal",
                      "files",
                      "browser",
                      "load"
                    ],
                    "description": "terminal: every terminal on it, the agent's commands and a person's shells alike, on one socket in terminal@1: text messages are TerminalEvent one way and TerminalInput the other. Watching reads them all; operating also opens a shell, types into any of them, the agent's included, sizes and stops them. files: its workspace's files, in files@1: text messages are FilesRequest one way and FilesAnswer the other, and a file's bytes travel as binary messages of at most 1,048,576 bytes. Watching lists and reads; operating also writes, which a computer with read access doesn't offer. browser: its browser, in screencast@1: binary messages are JPEG frames of the page shown, text messages are ScreencastEvent one way and ScreencastInput the other. Nobody waits for anybody: the agent's tools and a person's input act on the same browser at once. The page shown is each socket's own. A socket is shown each new tab as it opens, until it sends a tab input to show or open one; from then its page changes only when that page closes. load: how busy it is, in metrics@1, to watch only: a LoadReading every two seconds while a socket is open, the first two seconds after the first socket opens, and the last one at once to a socket that opens later. One that can't be taken is left out, and a socket that hasn't read the one before is not sent the next. Nothing is read while nobody watches."
                  },
                  "protocol": {
                    "type": "string"
                  },
                  "operate": {
                    "type": "boolean",
                    "description": "Whether it can be operated",
                    "not only watched.": null
                  },
                  "unavailable": {
                    "type": "string",
                    "description": "Why it can't be opened now, if it can't."
                  }
                }
              }
            },
            "tools": {
              "type": "object",
              "required": [
                "computer",
                "browser"
              ],
              "properties": {
                "computer": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                },
                "browser": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                }
              }
            }
          }
        }
      ]
    },
    "websocket": false
  },
  {
    "operationId": "killComputer",
    "method": "DELETE",
    "path": "/v1/computers/{computerID}",
    "tool": "computer_kill",
    "summary": "Stop it for good and remove what the service made. A folder someone named stays.",
    "status": 204,
    "hasBody": false,
    "pathParameters": [
      "computerID"
    ],
    "queryParameters": [],
    "input": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "computerID": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "computerID"
      ]
    },
    "output": null,
    "websocket": false
  },
  {
    "operationId": "setComputerTimeout",
    "method": "POST",
    "path": "/v1/computers/{computerID}/timeout",
    "tool": "computer_set_timeout",
    "summary": "It now stops this many seconds from now, replacing any earlier timeout.",
    "status": 200,
    "hasBody": true,
    "pathParameters": [
      "computerID"
    ],
    "queryParameters": [],
    "input": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "computerID": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        },
        "timeout": {
          "type": "integer",
          "minimum": 1,
          "description": "Seconds from now until the computer stops."
        }
      },
      "required": [
        "computerID",
        "timeout"
      ]
    },
    "output": {
      "type": "object",
      "required": [
        "computerID",
        "name",
        "state",
        "access",
        "browser",
        "workspace",
        "startedAt",
        "endAt",
        "metadata",
        "endpoints"
      ],
      "properties": {
        "computerID": {
          "type": "string"
        },
        "name": {
          "type": "string"
        },
        "state": {
          "type": "string",
          "enum": [
            "running",
            "stopped",
            "failed"
          ]
        },
        "access": {
          "type": "string",
          "enum": [
            "none",
            "read",
            "files",
            "terminal"
          ],
          "description": "How far it reaches into files and commands, each level containing the one before: `read` has read, list and search; `files` adds edit; `terminal` adds exec_command, write_stdin and list_sessions. Below terminal, the browser's code-running tool is hidden."
        },
        "browser": {
          "type": "boolean"
        },
        "workspace": {
          "type": [
            "string",
            "null"
          ]
        },
        "startedAt": {
          "type": "string",
          "format": "date-time",
          "description": "When it last started."
        },
        "endAt": {
          "type": [
            "string",
            "null"
          ],
          "format": "date-time",
          "description": "When it will stop; null if it has no timeout."
        },
        "metadata": {
          "type": "object",
          "additionalProperties": {
            "type": "string",
            "maxLength": 1024
          },
          "maxProperties": 64,
          "description": "Your own labels, kept and returned as given."
        },
        "endpoints": {
          "type": "object",
          "required": [
            "computer",
            "browser"
          ],
          "description": "MCP over Streamable HTTP, each taking the computer's access token as a bearer.",
          "properties": {
            "computer": {
              "type": [
                "string",
                "null"
              ],
              "description": "The terminal and files."
            },
            "browser": {
              "type": [
                "string",
                "null"
              ],
              "description": "The browser."
            }
          }
        }
      }
    },
    "websocket": false
  },
  {
    "operationId": "stopComputer",
    "method": "POST",
    "path": "/v1/computers/{computerID}/stop",
    "tool": "computer_stop",
    "summary": "Stop what it is running. Its folder and its token stay, and it can start again.",
    "status": 200,
    "hasBody": false,
    "pathParameters": [
      "computerID"
    ],
    "queryParameters": [],
    "input": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "computerID": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "computerID"
      ]
    },
    "output": {
      "type": "object",
      "required": [
        "computerID",
        "name",
        "state",
        "access",
        "browser",
        "workspace",
        "startedAt",
        "endAt",
        "metadata",
        "endpoints"
      ],
      "properties": {
        "computerID": {
          "type": "string"
        },
        "name": {
          "type": "string"
        },
        "state": {
          "type": "string",
          "enum": [
            "running",
            "stopped",
            "failed"
          ]
        },
        "access": {
          "type": "string",
          "enum": [
            "none",
            "read",
            "files",
            "terminal"
          ],
          "description": "How far it reaches into files and commands, each level containing the one before: `read` has read, list and search; `files` adds edit; `terminal` adds exec_command, write_stdin and list_sessions. Below terminal, the browser's code-running tool is hidden."
        },
        "browser": {
          "type": "boolean"
        },
        "workspace": {
          "type": [
            "string",
            "null"
          ]
        },
        "startedAt": {
          "type": "string",
          "format": "date-time",
          "description": "When it last started."
        },
        "endAt": {
          "type": [
            "string",
            "null"
          ],
          "format": "date-time",
          "description": "When it will stop; null if it has no timeout."
        },
        "metadata": {
          "type": "object",
          "additionalProperties": {
            "type": "string",
            "maxLength": 1024
          },
          "maxProperties": 64,
          "description": "Your own labels, kept and returned as given."
        },
        "endpoints": {
          "type": "object",
          "required": [
            "computer",
            "browser"
          ],
          "description": "MCP over Streamable HTTP, each taking the computer's access token as a bearer.",
          "properties": {
            "computer": {
              "type": [
                "string",
                "null"
              ],
              "description": "The terminal and files."
            },
            "browser": {
              "type": [
                "string",
                "null"
              ],
              "description": "The browser."
            }
          }
        }
      }
    },
    "websocket": false
  },
  {
    "operationId": "startComputer",
    "method": "POST",
    "path": "/v1/computers/{computerID}/start",
    "tool": "computer_start",
    "summary": "Start a stopped computer again, with the same token and folder.",
    "status": 200,
    "hasBody": true,
    "pathParameters": [
      "computerID"
    ],
    "queryParameters": [],
    "input": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "computerID": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        },
        "timeout": {
          "type": "integer",
          "minimum": 1,
          "description": "Seconds from now until the computer stops."
        }
      },
      "required": [
        "computerID"
      ]
    },
    "output": {
      "type": "object",
      "required": [
        "computerID",
        "name",
        "state",
        "access",
        "browser",
        "workspace",
        "startedAt",
        "endAt",
        "metadata",
        "endpoints"
      ],
      "properties": {
        "computerID": {
          "type": "string"
        },
        "name": {
          "type": "string"
        },
        "state": {
          "type": "string",
          "enum": [
            "running",
            "stopped",
            "failed"
          ]
        },
        "access": {
          "type": "string",
          "enum": [
            "none",
            "read",
            "files",
            "terminal"
          ],
          "description": "How far it reaches into files and commands, each level containing the one before: `read` has read, list and search; `files` adds edit; `terminal` adds exec_command, write_stdin and list_sessions. Below terminal, the browser's code-running tool is hidden."
        },
        "browser": {
          "type": "boolean"
        },
        "workspace": {
          "type": [
            "string",
            "null"
          ]
        },
        "startedAt": {
          "type": "string",
          "format": "date-time",
          "description": "When it last started."
        },
        "endAt": {
          "type": [
            "string",
            "null"
          ],
          "format": "date-time",
          "description": "When it will stop; null if it has no timeout."
        },
        "metadata": {
          "type": "object",
          "additionalProperties": {
            "type": "string",
            "maxLength": 1024
          },
          "maxProperties": 64,
          "description": "Your own labels, kept and returned as given."
        },
        "endpoints": {
          "type": "object",
          "required": [
            "computer",
            "browser"
          ],
          "description": "MCP over Streamable HTTP, each taking the computer's access token as a bearer.",
          "properties": {
            "computer": {
              "type": [
                "string",
                "null"
              ],
              "description": "The terminal and files."
            },
            "browser": {
              "type": [
                "string",
                "null"
              ],
              "description": "The browser."
            }
          }
        }
      }
    },
    "websocket": false
  },
  {
    "operationId": "getComputerLogs",
    "method": "GET",
    "path": "/v1/computers/{computerID}/logs",
    "tool": "computer_logs",
    "summary": "What its servers wrote, and each request it was sent.",
    "status": 200,
    "hasBody": false,
    "pathParameters": [
      "computerID"
    ],
    "queryParameters": [],
    "input": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "computerID": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "computerID"
      ]
    },
    "output": {
      "type": "object",
      "required": [
        "logs"
      ],
      "properties": {
        "logs": {
          "type": "array",
          "items": {
            "type": "object",
            "required": [
              "timestamp",
              "line"
            ],
            "properties": {
              "timestamp": {
                "type": "string",
                "format": "date-time"
              },
              "line": {
                "type": "string"
              }
            }
          }
        }
      }
    },
    "websocket": false
  },
  {
    "operationId": "createLiveSession",
    "method": "POST",
    "path": "/v1/computers/{computerID}/live",
    "tool": "computer_live",
    "summary": "A one-time ticket to watch or operate one of its surfaces live: its terminals, its files, its browser, or its load. Open its url as a WebSocket within 60 seconds.",
    "status": 201,
    "hasBody": true,
    "pathParameters": [
      "computerID"
    ],
    "queryParameters": [],
    "input": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "computerID": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        },
        "surface": {
          "type": "string",
          "enum": [
            "terminal",
            "files",
            "browser",
            "load"
          ],
          "description": "terminal: every terminal on it, the agent's commands and a person's shells alike, on one socket in terminal@1: text messages are TerminalEvent one way and TerminalInput the other. Watching reads them all; operating also opens a shell, types into any of them, the agent's included, sizes and stops them. files: its workspace's files, in files@1: text messages are FilesRequest one way and FilesAnswer the other, and a file's bytes travel as binary messages of at most 1,048,576 bytes. Watching lists and reads; operating also writes, which a computer with read access doesn't offer. browser: its browser, in screencast@1: binary messages are JPEG frames of the page shown, text messages are ScreencastEvent one way and ScreencastInput the other. Nobody waits for anybody: the agent's tools and a person's input act on the same browser at once. The page shown is each socket's own. A socket is shown each new tab as it opens, until it sends a tab input to show or open one; from then its page changes only when that page closes. load: how busy it is, in metrics@1, to watch only: a LoadReading every two seconds while a socket is open, the first two seconds after the first socket opens, and the last one at once to a socket that opens later. One that can't be taken is left out, and a socket that hasn't read the one before is not sent the next. Nothing is read while nobody watches."
        },
        "mode": {
          "allOf": [
            {
              "type": "string",
              "enum": [
                "watch",
                "operate"
              ],
              "description": "In watch you see and don't act: what you send is dropped, except that a files socket may still ask to list, to read and for what changed."
            }
          ],
          "default": "watch"
        }
      },
      "required": [
        "computerID",
        "surface"
      ]
    },
    "output": {
      "type": "object",
      "required": [
        "url",
        "protocol",
        "surface",
        "mode",
        "expiresAt"
      ],
      "properties": {
        "url": {
          "type": "string",
          "description": "The WebSocket to open",
          "once.": null
        },
        "protocol": {
          "type": "string"
        },
        "surface": {
          "type": "string",
          "enum": [
            "terminal",
            "files",
            "browser",
            "load"
          ],
          "description": "terminal: every terminal on it, the agent's commands and a person's shells alike, on one socket in terminal@1: text messages are TerminalEvent one way and TerminalInput the other. Watching reads them all; operating also opens a shell, types into any of them, the agent's included, sizes and stops them. files: its workspace's files, in files@1: text messages are FilesRequest one way and FilesAnswer the other, and a file's bytes travel as binary messages of at most 1,048,576 bytes. Watching lists and reads; operating also writes, which a computer with read access doesn't offer. browser: its browser, in screencast@1: binary messages are JPEG frames of the page shown, text messages are ScreencastEvent one way and ScreencastInput the other. Nobody waits for anybody: the agent's tools and a person's input act on the same browser at once. The page shown is each socket's own. A socket is shown each new tab as it opens, until it sends a tab input to show or open one; from then its page changes only when that page closes. load: how busy it is, in metrics@1, to watch only: a LoadReading every two seconds while a socket is open, the first two seconds after the first socket opens, and the last one at once to a socket that opens later. One that can't be taken is left out, and a socket that hasn't read the one before is not sent the next. Nothing is read while nobody watches."
        },
        "mode": {
          "type": "string",
          "enum": [
            "watch",
            "operate"
          ],
          "description": "In watch you see and don't act: what you send is dropped, except that a files socket may still ask to list, to read and for what changed."
        },
        "expiresAt": {
          "type": "string",
          "format": "date-time"
        }
      }
    },
    "websocket": false
  },
  {
    "operationId": "openLiveSession",
    "method": "GET",
    "path": "/v1/live/{liveID}",
    "summary": "Open a live session as a WebSocket. The ticket in its path is its authority and works once, so it takes no token. A request with an Origin header is refused unless the service was told to allow that origin.",
    "status": 101,
    "hasBody": false,
    "pathParameters": [
      "liveID"
    ],
    "queryParameters": [],
    "input": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "liveID": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        }
      },
      "required": [
        "liveID"
      ]
    },
    "output": null,
    "websocket": true
  }
];

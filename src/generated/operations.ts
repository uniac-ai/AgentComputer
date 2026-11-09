// Generated from openapi.yaml by scripts/generate.js. Don't edit.
export const OPENAPI = {
  "openapi": "3.1.0",
  "info": {
    "title": "AgentComputer",
    "version": "0.0.2",
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
        "description": "How far it reaches into files and commands, each level containing the one before: `read` has read, list and search; `files` adds edit; `terminal` adds exec_command and write_stdin. Below terminal, the browser's code-running tool is hidden."
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
              "tools"
            ],
            "properties": {
              "uptimeSeconds": {
                "type": "integer"
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
  tool: string;
  summary: string;
  status: number;
  hasBody: boolean;
  pathParameters: string[];
  queryParameters: string[];
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
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
    }
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
            "description": "How far it reaches into files and commands, each level containing the one before: `read` has read, list and search; `files` adds edit; `terminal` adds exec_command and write_stdin. Below terminal, the browser's code-running tool is hidden."
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
    }
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
          "description": "How far it reaches into files and commands, each level containing the one before: `read` has read, list and search; `files` adds edit; `terminal` adds exec_command and write_stdin. Below terminal, the browser's code-running tool is hidden."
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
              "description": "How far it reaches into files and commands, each level containing the one before: `read` has read, list and search; `files` adds edit; `terminal` adds exec_command and write_stdin. Below terminal, the browser's code-running tool is hidden."
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
    }
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
              "description": "How far it reaches into files and commands, each level containing the one before: `read` has read, list and search; `files` adds edit; `terminal` adds exec_command and write_stdin. Below terminal, the browser's code-running tool is hidden."
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
            "tools"
          ],
          "properties": {
            "uptimeSeconds": {
              "type": "integer"
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
    }
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
    "output": null
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
          "description": "How far it reaches into files and commands, each level containing the one before: `read` has read, list and search; `files` adds edit; `terminal` adds exec_command and write_stdin. Below terminal, the browser's code-running tool is hidden."
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
          "description": "How far it reaches into files and commands, each level containing the one before: `read` has read, list and search; `files` adds edit; `terminal` adds exec_command and write_stdin. Below terminal, the browser's code-running tool is hidden."
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
          "description": "How far it reaches into files and commands, each level containing the one before: `read` has read, list and search; `files` adds edit; `terminal` adds exec_command and write_stdin. Below terminal, the browser's code-running tool is hidden."
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
    }
  }
];

# Provider capabilities

Praxis has one `ProviderSession` seam, not one identical capability set. A model keeps
the native tools and behavior of its harness; Praxis must gate UI and prompts by declared
capabilities instead of assuming Claude, Codex, gateways, and Gemini are interchangeable.

| Capability | Claude Agent SDK | Codex SDK | Custom gateway | Gemini (experimental) |
| --- | --- | --- | --- | --- |
| Persistent multi-turn context | Yes | Yes | Yes, through Codex | No guaranteed continuity |
| Repository instruction discovery | `CLAUDE.md` + Claude skills | Codex-native instructions + Praxis rules | Same as Codex | Limited |
| Provider-native coding tools | Yes | Yes | Depends on model through Codex | Limited |
| Praxis preview MCP tools | Yes | No | No | No |
| Praxis worktree control tools | No | Yes | Yes, through Codex | No |
| Praxis question cards | Yes | No | No | No |
| Praxis approve/deny cards | Yes | No SDK approval event | No SDK approval event | No |
| Image input | Yes | Not wired | Not wired | Not wired |
| Resume provider thread | Yes | Not wired | Not wired | No |
| Detached background agents (comments + complex text edits) | Yes | Disabled | Disabled | Disabled |
| Custom endpoint | No | Built-in ChatGPT seat | Yes (`/responses`) | No |

“No” often means Praxis has not built the bridge, not that the underlying model can
never support the feature. Codex and gateway sessions receive a session-scoped local MCP
server with `workspace_state` and `prepare_conflict_resolution`: the former reads the
landing coordinator rather than guessing from the private checkout, while the latter
routes the existing three-way resolver through Praxis's repository queue. It deliberately
does not expose raw Git or discard/reset operations. Preview tools remain Claude-only;
question cards, resume, image transport, and detached background-agent support are separately
declared because they have different lifecycle and security requirements.

Preview comments and agent-required inline text edits inherit the originating chat's
selected provider/model settings. A detached child starts only when that provider
declares background-spawn support (Claude today). An unsupported comment routes into
its parent chat; an unsupported text edit is left in the composer for explicit review.
The rail always shows the harness/model the child actually received.

Until capability negotiation exists in `src/shared/api.ts`, the product should avoid
promising unsupported actions in backend-agnostic copy. Open-model connections inherit
the Codex harness's strengths and gaps; changing the model id does not grant Claude's
in-process preview/design tools. It does retain the two Praxis worktree-control tools
because those belong to the harness, not the selected endpoint model.

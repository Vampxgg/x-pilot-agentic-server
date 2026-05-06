# X-Pilot Agentic Server

AI Agentic Server Foundation for the X-Pilot Vocational Education Platform.

## Architecture

- **LangGraph.js** -- Core agent orchestration (graphs, state, checkpoints, parallel tasks)
- **OpenClaw-inspired agent structure** -- Folder-based agents with `.md` prompt files, per-agent memory/skills
- **Self-evolution system** -- Reflection, memory consolidation, skill crystallization
- **Declarative Pipeline** -- Multi-agent orchestration via YAML config (deterministic flow + creative reasoning)
- **Adaptive Routing** -- Intent classification routes requests to fast pipeline or interactive LLM mode
- **E2B Integration** -- 6 typed tools for project status, preflight, asset management, rendering, sharing, sandbox exec
- **Multi-tenancy & Workspace** -- Tenant/user isolation with per-session artifact management
- **Parallel execution** -- Sub-agent spawning, concurrent task processing, fan-out patterns
- **REST/WebSocket API** -- Core agent API + business domain routes

## Quick Start

```bash
# Install dependencies
npm install

# Copy environment file and configure API keys
cp .env.example .env

# Development
npm run dev

# Build and run
npm run build
npm start

# Run tests
npm test
```

## Project Structure

```
x-pilot-agentic-server/
├── apps/                    # Agent application layer (folder-per-app)
│   ├── _shared/             # Shared resources across apps
│   ├── _template/           # Template for creating new agents
│   ├── system/              # System-level application
│   │   └── orchestrator/    #   Built-in orchestrator agent
│   ├── teaching-resource/   # Teaching resource application
│   │   └── teaching-resource-generator/  # Teaching resource generation agent
│   ├── document-generation/ # Document generation application
│   │   ├── code/            # Business routes (auto-loaded)
│   │   ├── document-generator/   # Document generation orchestrator
│   │   └── section-writer/       # Section writer agent (parallel)
│   ├── ppt-generation/      # PPT generation application (two-stage interactive)
│   │   ├── code/            # Business routes (auto-loaded)
│   │   ├── ppt-outline-writer/   # Stage 1: topic research → Markdown outline
│   │   └── ppt-slide-generator/  # Stage 2: outline → JSONL slide data
│   ├── video-course/        # Video course application (multi-agent)
│   │   ├── code/                         # Business code module (auto-loaded)
│   │   ├── video-course-director/        # Video course main orchestrator
│   │   ├── video-script-creator/         # Script planning & scene orchestration
│   │   ├── scene-builder/                # Single scene spec builder (parallel)
│   │   ├── remotion-code-generator/      # Remotion TSX generation + E2B deploy
│   │   ├── remotion-scene-coder/         # Single scene TSX coder (parallel)
│   │   └── video-code-editor/            # Video code editing + E2B deploy
│   └── sim-training/               # 3D simulation training application (multi-agent)
│       ├── code/                         # Business code module (auto-loaded)
│       ├── sim-training-director/              # Main orchestrator (pipeline)
│       ├── sim-requirement-analyst/      # Guided Q&A requirement collection
│       ├── sim-scene-designer/           # Scene design + asset selection
│       ├── sim-code-generator/           # Parallel code generation orchestration
│       ├── sim-scene-coder/              # Single-scene R3F component generation
│       └── sim-validator/                # Build validation + deployment
├── sim-training-template/          # 3D simulation training frontend template (Three.js + React)
│   ├── src/engine/           # Simulation engine (step, score, interaction)
│   ├── src/components/       # UI overlays + 3D scene components
│   ├── src/hooks/            # useStep, useSimulation, useInteraction
│   └── src/scenes/           # AI-generated scene code goes here
├── config/
│   └── default.yaml         # Runtime configuration
├── data/                    # Runtime data (tenant-isolated)
│   └── tenants/<id>/        # Per-tenant storage
│       ├── agents/<name>/memory/  # Agent memory files
│       └── users/<id>/workspaces/ # Session workspace artifacts
├── src/
│   ├── api/                 # Fastify REST/WebSocket API
│   │   ├── routes/          # Core routes (agent, task, health)
│   │   ├── route-registry.ts # Business route registry (auto-loaded from apps/)
│   │   └── middleware/      # Auth (tenant/user extraction)
│   ├── core/                # Agent registry, graph, runtime, workspace, sub-agent manager
│   │   ├── stream-protocol.ts # SSE event factory functions (v2)
│   │   ├── sse-writer.ts     # Unified SSE writer (format + heartbeat + sequence IDs)
│   ├── evolution/           # Self-reflection, evolution, heartbeat, skill crystallization
│   ├── llm/                 # LLM provider abstraction and model routing
│   ├── memory/              # 3-layer memory system (working, daily, long-term)
│   ├── skills/              # Skill loader, registry, built-in skills
│   ├── tools/               # Tool registry, executor, built-in tools
│   │   ├── built-in/        # Built-in tool implementations
│   │   └── knowledge/       # Knowledge retrieval engine (Dify + RRF + Rerank)
│   └── utils/               # Logger, config, markdown parser, template parser
└── tests/
```

## Agent Folder Structure

Each agent is a self-contained folder under `apps/<app-name>/`:

| File | Purpose |
|------|---------|
| `IDENTITY.md` | Name, role, personality |
| `SOUL.md` | Core values (CORE) and evolvable behaviors (MUTABLE) |
| `MISSION.md` | Objectives and success criteria |
| `TOOLS.md` | Tool usage guidelines |
| `BOOTSTRAP.md` | First-run initialization (optional) |
| `HEARTBEAT.md` | Periodic maintenance behavior (optional) |
| `agent.config.yaml` | Model, maxTokens, concurrency, timeout, pipeline, outputFormat settings |
| `memory/MEMORY.md` | Persistent long-term memory |
| `skills/*.md` | Reusable behavioral patterns (optional) |

## API Endpoints

### Core Agent API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/agents` | List all agents |
| `GET` | `/api/agents/:name` | Agent details |
| `POST` | `/api/agents/:name/invoke` | Execute agent (blocking) |
| `POST` | `/api/agents/:name/stream` | Execute agent (SSE streaming) |
| `POST` | `/api/agents` | Create new agent at runtime |
| `POST` | `/api/agents/:name/reload` | Reload agent from disk |
| `GET` | `/api/agents/:name/memory` | Query agent memory |
| `POST` | `/api/agents/:name/memory` | Write to agent memory |
| `GET` | `/api/tasks/:id` | Get task status |
| `GET` | `/api/tasks` | List tasks |
| `WS` | `/ws/agents/:name` | Bidirectional WebSocket streaming |

### Business Domain API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/business/document-generation/upload-template` | Upload & parse Word template (.docx) |
| `POST` | `/api/business/document-generation/generate` | Generate document (blocking) |
| `POST` | `/api/business/document-generation/generate-stream` | Generate document (SSE streaming) |
| `POST` | `/api/business/video-course/generate` | Generate video course (blocking) |
| `POST` | `/api/business/video-course/generate-stream` | Generate video course (SSE streaming) |
| `POST` | `/api/business/video-course/edit` | Edit existing video course |
| `POST` | `/api/business/sim-training/create` | Create 3D simulation training (blocking) |
| `POST` | `/api/business/sim-training/create-stream` | Create 3D simulation training (SSE streaming) |
| `GET` | `/api/business/sim-training/list` | List deployed simulations |
| `GET` | `/api/business/sim-training/:id` | Get simulation detail |
| `DELETE` | `/api/business/sim-training/:id` | Delete simulation |
| `POST` | `/api/business/sim-training/rebuild` | Rebuild simulation |

### PPT Generation API

Two-stage interactive flow: the user reviews/edits the outline before submitting it to slide generation.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/business/ppt-generation/outline` | Stage 1 — generate outline (blocking) |
| `POST` | `/api/business/ppt-generation/outline-stream` | Stage 1 — generate outline (SSE streaming) |
| `POST` | `/api/business/ppt-generation/slides` | Stage 2 — generate JSONL slide data (blocking) |
| `POST` | `/api/business/ppt-generation/slides-stream` | Stage 2 — generate JSONL slide data (SSE streaming) |
| `GET` | `/api/business/ppt-generation/sessions/:sessionId/sources` | Query data source references (provenance) |

**Stage 1 request** (`POST .../outline`):
```json
{
  "topic": "演示文稿主题（必填）",
  "prompt": "附加要求（可选）",
  "language": "中文",
  "density": "auto | streamline | medium | rich",
  "database_id": "知识库ID（可选）",
  "smart_search": 0,
  "large_text": "前端提取的上传文件文本（可选）"
}
```
Returns `{ sessionId, outline }` — save `sessionId` for Stage 2.

**Stage 2 request** (`POST .../slides`):
```json
{
  "outline": "用户编辑后的 Markdown 大纲（必填）",
  "sessionId": "阶段1返回的 sessionId（必填）",
  "language": "中文",
  "style": "professional"
}
```
Returns `{ sessionId, slides }` — `slides` is a JSONL string (one JSON object per line) for frontend rendering.

### Image Hub API (global library)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/images/upload` | Multipart upload |
| `GET` | `/api/images` | List with filters / pagination |
| `GET` | `/api/images/:id` | Metadata |
| `GET` | `/api/images/:id/file` | Binary stream |
| `PATCH` | `/api/images/:id` | Update metadata |
| `DELETE` | `/api/images/:id` | Delete record & file |
| `POST` | `/api/images/from-url` | Import from URL |
| `POST` | `/api/images/resolve` | Match images by section context |

Full request/response details (Chinese): [docs/图床服务器.md](docs/图床服务器.md).

### SSE Event Stream Protocol (v2)

All streaming endpoints (`/stream`) use a unified SSE event protocol. Each event follows this envelope:

```json
{"event":"<type>","id":1,"task_id":"task_8f3a","session_id":"sess_01","created_at":1710000000.0,"data":{...}}
```

**Event types**: `task_started` / `task_finished` / `done` / `ping` / `node_started` / `node_finished` / `message` / `message_end` / `tool_started` / `tool_finished` / `agent_started` / `agent_message` / `agent_tool_started` / `agent_tool_finished` / `agent_finished` / `thinking` / `progress` / `error`

**Three-layer ID system**:
- `task_id` — single request lifecycle (in every event)
- `session_id` — business session / workspace (in every event)
- `thread_id` — conversation thread for multi-turn (in `task_started.data` only)

Response headers: `X-Stream-Protocol: 2.0`, `X-Task-Id`, `X-Session-Id`

See `src/core/types.ts` for full TypeScript type definitions, `src/core/stream-protocol.ts` for factory functions, and `src/core/sse-writer.ts` for the unified SSE writer.

## Key Capabilities

### Self-Evolution
- Post-task reflection with structured lesson extraction
- Memory consolidation (daily logs -> long-term memory)
- Skill crystallization (repeated patterns -> reusable skills)
- Evolution proposals with human approval gates

### Declarative Pipeline + Adaptive Routing
- Multi-agent orchestration via `pipeline` config in `agent.config.yaml`
- Step dependencies, parallel fan-out, optional steps
- Deterministic flow control with creative reasoning inside each step
- **Adaptive routing**: route-level intent classification chooses pipeline (fast, complete intent) vs LLM mode (interactive, vague intent)
- `skipPipeline` option allows runtime bypass of pipeline for interactive flows

### Parallel Execution
- Sub-agent spawning via `spawn_sub_agent` tool
- Batch parallel execution via `spawn_parallel_agents` tool
- Concurrent task execution with `p-queue`
- Result aggregation across parallel sub-agents

### Built-in Tools

| Tool | Description |
|------|-------------|
| `code_executor` | Execute TypeScript/Python code |
| `http_request` | HTTP requests |
| `file_read` / `file_write` / `file_list` | File operations |
| `shell` | Shell commands |
| `spawn_sub_agent` | Delegate task to another agent |
| `spawn_parallel_agents` | Batch-spawn multiple sub-agents in parallel |
| `knowledge_search` | Search knowledge base via Dify (hybrid search, RRF fusion, reranking) |
| `knowledge_list` | List available Dify knowledge bases (datasets) |
| `knowledge_doc_retrieve` | Retrieve full document content from a knowledge base |
| `web_search` | Search the web via SearchApi.io (Google). Returns title, link, snippet, images, knowledge_graph, inline_images. Optional `extract_content: true` fetches and extracts main content from top 5 URLs (HTML, denoised). |
| `workspace_write` / `workspace_read` / `workspace_list` | Session workspace artifact management |
| `image_generate` | AI image generation |
| `event_emit` | Emit events to the event bus |
| `create_agent` | Create new agents at runtime (supports `group` for app placement) |
| `e2b_project_status` | Get E2B project status & preview data |
| `e2b_preflight` | E2B runtime preflight check (detect code errors) |
| `e2b_manage_assets` | Manage E2B project assets (upload/list/get/delete) |
| `e2b_render` | Render video on E2B (start/poll/queue) |
| `e2b_share` | Get E2B share link / project profile |
| `e2b_sandbox_exec` | Execute command in E2B sandbox |
| `asset_search` | Search 3D asset catalog by category/keyword |
| `asset_metadata` | Get detailed 3D asset metadata |
| `sim_project_init` | Initialize simulation project from template |
| `sim_inject_scene` | Inject scene code into simulation project |
| `sim_build` | Build simulation project (npm build) |
| `sim_deploy` | Deploy built simulation to serving directory |
| `sim_preview` | Get preview URL for deployed simulation |

## Configuration

See `config/default.yaml` for all options. Environment variables in `.env` override config values.

### LLM Provider Routing

The base framework supports multiple LLM providers via [src/llm/provider.ts](src/llm/provider.ts). When `agent.config.yaml` does not declare an explicit `provider`, the model name is auto-classified by `resolveProvider()`:

| Model name pattern | Resolved provider |
|---|---|
| contains `/` (e.g. `moonshotai/kimi-k2.5`, `google/gemini-3.1-pro-preview`) | `openrouter` |
| starts with `claude` | `anthropic` |
| starts with `glm` / `chatglm` | `zhipu` |
| starts with `qwen` | `qwen` |
| starts with `deepseek` | `deepseek` |
| anything else (e.g. `gpt-4o`) | `openai` |

To bypass auto-classification, write `provider: <name>` alongside `model:` in the agent config. This is **required** for Vertex AI (bare names like `gemini-2.5-pro` would otherwise fall through to OpenAI).

### Google Vertex AI Setup

To use Google's official Vertex AI (instead of OpenRouter passthrough):

1. **Create a Service Account** in [GCP IAM](https://console.cloud.google.com/iam-admin/serviceaccounts), grant the `Vertex AI User` role.
2. **Generate and download a JSON key**, save it as `secrets/vertex-sa.json` (or any path you prefer; the directory is gitignored).
3. **Configure `.env`**:
   ```bash
   GOOGLE_APPLICATION_CREDENTIALS=./secrets/vertex-sa.json
   GOOGLE_CLOUD_PROJECT=your-gcp-project-id
   GOOGLE_CLOUD_LOCATION=us-central1
   ```
4. **Use it in `agent.config.yaml`** by setting `provider: vertex` + the bare Vertex model name:
   ```yaml
   provider: vertex
   model: gemini-2.5-pro          # or gemini-2.5-flash / gemini-2.5-pro-002, etc.
   ```

> Known schema limitation: Vertex Gemini does not accept `z.union()` / `z.discriminatedUnion()` for tool input schemas. Use flat objects with optional fields instead. See [@langchain/google-vertexai docs](https://www.npmjs.com/package/@langchain/google-vertexai) for details.

### Fallback Models (multi-provider failover)

Each agent can declare a fallback chain via `fallbackModels`. Two forms are supported and may be **mixed freely**:

```yaml
# Most common: cross-provider failover via auto-detection
provider: vertex
model: gemini-2.5-pro
fallbackModels:
  - moonshotai/kimi-k2.5                          # string -> auto: openrouter

# Mixed: same-provider downgrade first, then cross-provider fallback
provider: vertex
model: gemini-2.5-pro
fallbackModels:
  - { model: gemini-2.5-flash, provider: vertex } # explicit provider for bare names
  - moonshotai/kimi-k2.5

# High-availability: multiple direct providers
provider: vertex
model: gemini-2.5-pro
fallbackModels:
  - { model: gemini-2.5-flash, provider: vertex }
  - { model: claude-sonnet-4-6, provider: anthropic }
  - { model: gpt-4o, provider: openai }
```

When the primary model errors (HTTP 4xx/5xx, timeout, network), LangChain's `withFallbacks` tries the chain in order. Each model has its own per-instance HTTP retry (`maxRetries: 3` by default) before the chain advances to the next entry.

### Knowledge Retrieval Configuration

| Env Variable | Description | Default |
|---|---|---|
| `DIFY_API_BASE_URL` | Dify API endpoint | `http://119.45.167.133:5125/v1` |
| `DIFY_DATASET_API_KEY` | Dify dataset API key | — |
| `SILICONFLOW_API_KEY` | SiliconFlow API key for reranking | — |
| `RERANK_ENABLED` | Enable external reranker | `true` |
| `RERANK_MODEL` | Reranker model | `BAAI/bge-reranker-v2-m3` |
| `KNOWLEDGE_DEFAULT_SEARCH_METHOD` | Default search method | `hybrid_search` |
| `KNOWLEDGE_DEFAULT_TOP_K` | Default max results | `10` |
| `KNOWLEDGE_SCORE_THRESHOLD` | Minimum relevance score | `0` |
| `KNOWLEDGE_MAX_TOKENS` | Token budget for results | `8000` |

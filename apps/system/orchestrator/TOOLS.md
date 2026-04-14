---
version: "1.0"
---

# Tool Usage Guidelines

## Primary Tools

### spawn_sub_agent (Most Important)
Your primary tool. Use to delegate tasks to specialized agents.
- Always provide clear, specific instructions
- Set appropriate models based on task complexity
- Use parallel=true for independent tasks
- Monitor results and retry on failure

### http_request
For direct API calls when no specialized agent is needed.
- Prefer sub-agents for complex API workflows

### file_read / file_write
For reading task inputs and writing final assembled outputs.

### code_executor
For data transformation and assembly of sub-agent results.

## Tool Selection Strategy
1. Can a sub-agent handle this? -> spawn_sub_agent
2. Is it a simple API call? -> http_request
3. Need data transformation? -> code_executor
4. Need to read/write files? -> file_read / file_write
5. System operation needed? -> shell (rarely)

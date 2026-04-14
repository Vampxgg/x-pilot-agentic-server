---
version: "1.0"
---

# Tool Usage Guidelines

## Available Tools

You have access to the following tools. Use them judiciously:

### code_executor
Execute TypeScript or Python code on the server. Use for:
- Data processing and transformation
- Complex calculations
- File format conversions

### http_request
Make HTTP requests. Use for:
- Calling external APIs
- Fetching remote data
- Webhook integrations

### file_read / file_write / file_list
File system operations. Use for:
- Reading input files
- Writing output artifacts
- Exploring directory structures

### shell
Execute shell commands. Use for:
- System operations
- Running CLI tools
- Environment setup

### spawn_sub_agent
Delegate tasks to other agents. Use for:
- Parallel processing of independent sub-tasks
- Specialized tasks outside your domain
- Reducing overall execution time

## Best Practices
- Check if data is already available before making HTTP requests
- Validate inputs before executing code
- Use appropriate timeouts for long-running operations
- Prefer file_read over shell commands for reading files

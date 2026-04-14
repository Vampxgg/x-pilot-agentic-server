import json
import sys

# To support printing utf-8 to terminal
sys.stdout.reconfigure(encoding='utf-8')

with open('data/tenants/default/users/default/workspaces/test7/logs/trace_document-generator_1773723635171.json', 'r', encoding='utf-8') as f:
    data = json.load(f)

def print_tree(node, depth=0):
    indent = '  ' * depth
    name = node.get("name", "Unknown")
    node_type = node.get("type", "unknown")
    duration = node.get("durationMs", 0)
    
    # Skip noisy internal langgraph nodes to keep it clean
    if name in ["ChannelWrite", "RunnableLambda", "RunnableSequence", "RunnableWithFallbacks"]:
        for c in node.get('children', []):
            print_tree(c, depth)
        return

    extra = ""
    # If it's a tool, print the inputs and outputs
    if node_type == 'tool':
        inputs = node.get("inputs", {}).get("input", "")
        # The input is often stringified JSON, try to parse it to show just tool arguments
        try:
            parsed = json.loads(inputs)
            # Find a meaningful key
            if "query" in parsed:
                inputs = f"Query: {parsed['query']}"
            elif "message" in parsed:
                inputs = f"Message: {parsed['message'][:50]}..."
            elif "content" in parsed:
                inputs = "Writing blueprint..."
            else:
                inputs = str(parsed)[:100]
        except:
            inputs = str(inputs)[:100]
            
        extra += f"\n{indent}  └─ 📥 Input: {inputs}"
        
        outputs = node.get("outputs", {}).get("output", "")
        if isinstance(outputs, str) and outputs:
            outputs = outputs.replace("\n", " ")[:100] + "..."
            extra += f"\n{indent}  └─ 📤 Output: {outputs}"
            
    # If it's an LLM, print token usage or messages
    if node_type == 'llm':
        outputs = node.get("outputs", {})
        generations = outputs.get("generations", [])
        if generations and len(generations) > 0 and len(generations[0]) > 0:
            text = generations[0][0].replace("\n", " ")[:150]
            extra += f"\n{indent}  └─ 🤖 LLM generated text/tool calls..."
        
    print(f'{indent}▶ {name} [{node_type}] ({duration}ms){extra}')
    
    for c in node.get('children', []):
        print_tree(c, depth + 1)

print("===== TRACE SUMMARY: test7 =====")
for root in data.get('traces', []):
    print_tree(root)

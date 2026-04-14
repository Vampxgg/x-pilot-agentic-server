import json
with open('data/tenants/default/users/default/workspaces/test7/logs/trace_document-generator_1773723635171.json', 'r', encoding='utf-8') as f:
    data = json.load(f)

for child1 in data['traces'][0].get('children', []):
    for child2 in child1.get('children', []):
        for child3 in child2.get('children', []):
            if isinstance(child3, dict) and child3.get('type') == 'llm':
                # look at the 'action' field we injected in handleAgentAction, but wait, agent-graph doesn't use AgentExecutor, it just returns messages
                pass

def find_llm_messages(node):
    if node.get('type') == 'llm':
        # LangChain LLMs return a message object in the outputs if we cast properly, 
        # But handleLLMEnd only gives `output.generations[0][0].text`
        # Let's see what inputs the NEXT chain got
        pass
    for c in node.get('children', []):
        find_llm_messages(c)

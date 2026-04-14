#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Dify 工作流节点导入脚本
从 YAML 文件中提取代码节点、Prompt 节点、Agent 节点和模板节点，并生成结构化文档
"""

import sys
import os
import re
import yaml
import json
from pathlib import Path
from typing import Dict, List, Any, Optional
from collections import defaultdict


def sanitize_filename(name: str, max_length: int = 100) -> str:
    """清理文件名，移除特殊字符"""
    # 移除或替换特殊字符
    name = re.sub(r'[<>:"/\\|?*]', '_', name)
    name = re.sub(r'\s+', '_', name)
    name = name.strip('._')
    # 限制长度
    if len(name) > max_length:
        name = name[:max_length]
    return name or "unnamed"


def extract_code_node(node: Dict[str, Any], output_dir: Path) -> Optional[str]:
    """提取代码节点到 Python 文件"""
    node_id = str(node.get('id', ''))
    data = node.get('data', {})
    
    if data.get('type') != 'code':
        return None
    
    code = data.get('code', '')
    if not code:
        return None
    
    title = data.get('title', '未命名代码节点')
    desc = data.get('desc', '')
    
    # 生成文件名
    safe_title = sanitize_filename(title)
    filename = f"{node_id}_{safe_title}.py"
    filepath = output_dir / filename
    
    # 创建文件内容，添加元数据注释
    content = f'''# -*- coding: utf-8 -*-
"""
节点ID: {node_id}
节点标题: {title}
节点描述: {desc}
节点类型: code
"""

{code}
'''
    
    # 写入文件
    filepath.write_text(content, encoding='utf-8')
    return str(filepath.relative_to(output_dir.parent.parent))


def extract_prompt_node(node: Dict[str, Any], output_dir: Path) -> Optional[str]:
    """提取 LLM 节点的 Prompt 到 Markdown 文件"""
    node_id = str(node.get('id', ''))
    data = node.get('data', {})
    
    if data.get('type') != 'llm':
        return None
    
    prompt_template = data.get('prompt_template', [])
    if not prompt_template:
        return None
    
    title = data.get('title', data.get('desc', '未命名Prompt节点'))
    desc = data.get('desc', '')
    model = data.get('model', {})
    model_name = model.get('name', '未知模型')
    
    # 生成文件名
    safe_title = sanitize_filename(title)
    filename = f"{node_id}_{safe_title}.md"
    filepath = output_dir / filename
    
    # 构建 Markdown 内容
    content_parts = [f"# {title}\n"]
    content_parts.append(f"**节点ID:** `{node_id}`\n")
    content_parts.append(f"**节点描述:** {desc}\n")
    content_parts.append(f"**模型:** {model_name}\n")
    content_parts.append("\n---\n\n")
    
    # 处理 prompt_template 数组
    for i, prompt_item in enumerate(prompt_template):
        role = prompt_item.get('role', 'unknown')
        text = prompt_item.get('text', '')
        
        if role == 'system':
            content_parts.append(f"## System Prompt\n\n```\n{text}\n```\n\n")
        elif role == 'user':
            content_parts.append(f"## User Prompt\n\n```\n{text}\n```\n\n")
        else:
            content_parts.append(f"## {role.capitalize()} Prompt\n\n```\n{text}\n```\n\n")
    
    content = '\n'.join(content_parts)
    
    # 写入文件
    filepath.write_text(content, encoding='utf-8')
    return str(filepath.relative_to(output_dir.parent.parent))


def extract_agent_node(node: Dict[str, Any], output_dir: Path) -> Optional[str]:
    """提取 Agent 节点的 Instruction 到 Markdown 文件"""
    node_id = str(node.get('id', ''))
    data = node.get('data', {})
    
    if data.get('type') != 'agent':
        return None
    
    agent_params = data.get('agent_parameters', {})
    instruction = agent_params.get('instruction', {})
    prompt_text = instruction.get('value', '')
    
    if not prompt_text:
        return None
    
    title = data.get('title', data.get('desc', '未命名Agent节点'))
    desc = data.get('desc', '')
    
    model_info = agent_params.get('model', {}).get('value', {})
    model_name = model_info.get('model', '未知模型')
    provider = model_info.get('provider', '未知提供商')
    
    # 生成文件名
    safe_title = sanitize_filename(title)
    filename = f"{node_id}_{safe_title}.md"
    filepath = output_dir / filename
    
    # 构建 Markdown 内容
    content_parts = [f"# {title}\n"]
    content_parts.append(f"**节点ID:** `{node_id}`\n")
    content_parts.append(f"**节点类型:** Agent\n")
    content_parts.append(f"**节点描述:** {desc}\n")
    content_parts.append(f"**模型:** {model_name} ({provider})\n")
    content_parts.append("\n---\n\n")
    content_parts.append(f"## System/Instruction Prompt\n\n```markdown\n{prompt_text}\n```\n\n")
    
    content = '\n'.join(content_parts)
    
    # 写入文件
    filepath.write_text(content, encoding='utf-8')
    return str(filepath.relative_to(output_dir.parent.parent))


def extract_template_node(node: Dict[str, Any], output_dir: Path) -> Optional[str]:
    """提取模板节点到 Markdown 文件"""
    node_id = str(node.get('id', ''))
    data = node.get('data', {})
    
    if data.get('type') != 'template-transform':
        return None
    
    template = data.get('template', '')
    if not template:
        return None
    
    title = data.get('title', '未命名模板节点')
    desc = data.get('desc', '')
    
    # 生成文件名
    safe_title = sanitize_filename(title)
    filename = f"{node_id}_{safe_title}.md"
    filepath = output_dir / filename
    
    # 构建 Markdown 内容
    content = f'''# {title}

**节点ID:** `{node_id}`  
**节点描述:** {desc}  
**节点类型:** template-transform

---

## 模板内容

```handlebars
{template}
```

## 变量说明

'''
    
    # 添加变量信息
    variables = data.get('variables', [])
    if variables:
        content += "| 变量名 | 值选择器 | 值类型 |\n"
        content += "|--------|----------|--------|\n"
        for var in variables:
            var_name = var.get('variable', '')
            value_selector = var.get('value_selector', [])
            value_type = var.get('value_type', '')
            content += f"| `{var_name}` | `{value_selector}` | `{value_type}` |\n"
    else:
        content += "无变量\n"
    
    # 写入文件
    filepath.write_text(content, encoding='utf-8')
    return str(filepath.relative_to(output_dir.parent.parent))


def build_node_map(nodes: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """构建节点映射表"""
    node_map = {}
    for node in nodes:
        node_id = str(node.get('id', ''))
        data = node.get('data', {})
        node_map[node_id] = {
            'id': node_id,
            'type': data.get('type', 'unknown'),
            'title': data.get('title', data.get('desc', '未命名节点')),
            'desc': data.get('desc', ''),
            'position': node.get('position', {}),
        }
    return node_map


def build_connection_graph(edges: List[Dict[str, Any]], node_map: Dict[str, Dict[str, Any]]) -> Dict[str, List[str]]:
    """构建连接关系图"""
    graph = defaultdict(list)
    for edge in edges:
        source = str(edge.get('source', ''))
        target = str(edge.get('target', ''))
        if source and target and source in node_map and target in node_map:
            graph[source].append(target)
    return dict(graph)


def generate_readme(workflow_data: Dict[str, Any], node_map: Dict[str, Dict[str, Any]], 
                    graph: Dict[str, List[str]], code_files: List[str], 
                    prompt_files: List[str], agent_files: List[str], template_files: List[str]) -> str:
    """生成 README.md"""
    app_info = workflow_data.get('app', {})
    app_name = app_info.get('name', '未知工作流')
    app_desc = app_info.get('description', '')
    
    content = f'''# {app_name}

{app_desc}

## 工作流概述

本工作流包含以下类型的节点：

- **代码节点 (Code)**: {len(code_files)} 个
- **Agent 节点**: {len(agent_files)} 个
- **LLM 节点 (Prompt)**: {len(prompt_files)} 个
- **模板节点 (Template)**: {len(template_files)} 个
- **其他节点**: {len(node_map) - len(code_files) - len(prompt_files) - len(agent_files) - len(template_files)} 个

## 目录结构

```
dify-word-workspace/
├── Agent-创建视频剧本(4min).yml          # 原始工作流文件
├── import_workflow.py         # 导入脚本
├── nodes/
│   ├── code/                  # 代码节点
│   ├── agents/                # Agent 节点
│   ├── prompts/               # Prompt 节点
│   └── templates/             # 模板节点
├── docs/
│   └── workflow_structure.md  # 详细结构文档
└── README.md                  # 本文件
```

## 代码节点

'''
    
    if code_files:
        content += "| 节点ID | 标题 | 文件路径 |\n"
        content += "|--------|------|----------|\n"
        for file_path in sorted(code_files):
            filename = Path(file_path).stem
            parts = filename.split('_', 1)
            node_id = parts[0] if parts else 'unknown'
            title = parts[1] if len(parts) > 1 else 'unknown'
            node_info = node_map.get(node_id, {})
            display_title = node_info.get('title', title)
            content += f"| `{node_id}` | {display_title} | `{file_path}` |\n"
    else:
        content += "无代码节点\n"
        
    content += "\n## Agent 节点\n\n"
    
    if agent_files:
        content += "| 节点ID | 标题 | 文件路径 |\n"
        content += "|--------|------|----------|\n"
        for file_path in sorted(agent_files):
            filename = Path(file_path).stem
            parts = filename.split('_', 1)
            node_id = parts[0] if parts else 'unknown'
            node_info = node_map.get(node_id, {})
            display_title = node_info.get('title', 'unknown')
            content += f"| `{node_id}` | {display_title} | `{file_path}` |\n"
    else:
        content += "无 Agent 节点\n"
    
    content += "\n## Prompt 节点\n\n"
    
    if prompt_files:
        content += "| 节点ID | 标题 | 文件路径 |\n"
        content += "|--------|------|----------|\n"
        for file_path in sorted(prompt_files):
            filename = Path(file_path).stem
            parts = filename.split('_', 1)
            node_id = parts[0] if parts else 'unknown'
            node_info = node_map.get(node_id, {})
            display_title = node_info.get('title', 'unknown')
            content += f"| `{node_id}` | {display_title} | `{file_path}` |\n"
    else:
        content += "无 Prompt 节点\n"
    
    content += "\n## 模板节点\n\n"
    
    if template_files:
        content += "| 节点ID | 标题 | 文件路径 |\n"
        content += "|--------|------|----------|\n"
        for file_path in sorted(template_files):
            filename = Path(file_path).stem
            parts = filename.split('_', 1)
            node_id = parts[0] if parts else 'unknown'
            node_info = node_map.get(node_id, {})
            display_title = node_info.get('title', 'unknown')
            content += f"| `{node_id}` | {display_title} | `{file_path}` |\n"
    else:
        content += "无模板节点\n"
    
    content += "\n## 节点连接关系\n\n"
    content += "主要连接关系（前20个）：\n\n"
    
    connection_count = 0
    for source_id, targets in list(graph.items())[:20]:
        source_info = node_map.get(source_id, {})
        source_title = source_info.get('title', source_id)
        content += f"- `{source_id}` ({source_title}) → "
        target_titles = []
        for target_id in targets[:5]:  # 只显示前5个目标
            target_info = node_map.get(target_id, {})
            target_titles.append(f"`{target_id}` ({target_info.get('title', target_id)})")
        content += ", ".join(target_titles)
        if len(targets) > 5:
            content += f" ... (共 {len(targets)} 个)"
        content += "\n"
        connection_count += 1
    
    if len(graph) > 20:
        content += f"\n... 还有 {len(graph) - 20} 个连接关系，详见 `docs/workflow_structure.md`\n"
    
    content += "\n## 使用方法\n\n"
    content += "1. 运行导入脚本：\n"
    content += "   ```bash\n"
    content += "   python import_workflow.py\n"
    content += "   ```\n"
    content += "\n2. 查看提取的节点文件：\n"
    content += "   - 代码节点：`nodes/code/`\n"
    content += "   - Agent 节点：`nodes/agents/`\n"
    content += "   - Prompt 节点：`nodes/prompts/`\n"
    content += "   - 模板节点：`nodes/templates/`\n"
    content += "\n3. 查看详细文档：`docs/workflow_structure.md`\n"
    
    return content


def generate_structure_doc(workflow_data: Dict[str, Any], node_map: Dict[str, Dict[str, Any]], 
                          graph: Dict[str, List[str]]) -> str:
    """生成详细的工作流结构文档"""
    app_info = workflow_data.get('app', {})
    app_name = app_info.get('name', '未知工作流')
    
    content = f'''# {app_name} - 工作流结构文档

## 节点信息表

| 节点ID | 类型 | 标题 | 描述 |
|--------|------|------|------|
'''
    
    # 按节点ID排序
    for node_id in sorted(node_map.keys()):
        node_info = node_map[node_id]
        node_type = node_info.get('type', 'unknown')
        title = node_info.get('title', '未命名')
        desc = node_info.get('desc', '')
        # 转义表格中的特殊字符
        title = title.replace('|', '\\|')
        desc = desc.replace('|', '\\|').replace('\n', ' ')
        if len(desc) > 50:
            desc = desc[:50] + '...'
        content += f"| `{node_id}` | {node_type} | {title} | {desc} |\n"
    
    content += "\n## 连接关系图\n\n"
    content += "```mermaid\n"
    content += "graph TD\n"
    
    # 生成 Mermaid 图（限制节点数量以避免图表过大）
    node_ids_list = list(node_map.keys())[:50]  # 限制前50个节点
    node_id_map = {node_id: f"Node{idx}" for idx, node_id in enumerate(node_ids_list)}
    
    # 添加节点定义
    for node_id, node_var in node_id_map.items():
        node_info = node_map[node_id]
        title = node_info.get('title', node_id)
        node_type = node_info.get('type', 'unknown')
        # 清理标题中的特殊字符
        title_clean = re.sub(r'[^\w\s-]', '', title)[:30]
        content += f'    {node_var}["{title_clean}<br/>{node_type}"]\n'
    
    # 添加连接
    edge_count = 0
    for source_id, targets in graph.items():
        if source_id in node_id_map and edge_count < 100:  # 限制边数量
            source_var = node_id_map[source_id]
            for target_id in targets:
                if target_id in node_id_map:
                    target_var = node_id_map[target_id]
                    content += f"    {source_var} --> {target_var}\n"
                    edge_count += 1
                    if edge_count >= 100:
                        break
        if edge_count >= 100:
            break
    
    content += "```\n\n"
    content += f"*注：由于节点数量较多，图中仅显示前50个节点和前100条连接关系。*\n\n"
    
    content += "## 详细连接关系\n\n"
    content += "### 按源节点分组\n\n"
    
    for source_id in sorted(graph.keys()):
        source_info = node_map.get(source_id, {})
        source_title = source_info.get('title', source_id)
        targets = graph[source_id]
        
        content += f"#### `{source_id}` - {source_title}\n\n"
        content += f"连接到以下 {len(targets)} 个节点：\n\n"
        
        for target_id in targets:
            target_info = node_map.get(target_id, {})
            target_title = target_info.get('title', target_id)
            content += f"- `{target_id}` - {target_title}\n"
        content += "\n"
    
    return content


def run_import(yaml_file: Path) -> bool:
    """对单个 YAML 文件执行导入，返回是否成功"""
    stem = yaml_file.stem.strip()  # 去除首尾空格，避免 Windows 路径问题
    workspace_dir = yaml_file.parent / (stem or "workflow")
    workspace_dir.mkdir(parents=True, exist_ok=True)

    if not yaml_file.exists():
        print(f"错误：找不到文件 {yaml_file}")
        return False

    # 创建输出目录
    nodes_dir = workspace_dir / "nodes"
    code_dir = nodes_dir / "code"
    prompts_dir = nodes_dir / "prompts"
    agents_dir = nodes_dir / "agents"
    templates_dir = nodes_dir / "templates"
    docs_dir = workspace_dir / "docs"
    
    for dir_path in [code_dir, prompts_dir, agents_dir, templates_dir, docs_dir]:
        dir_path.mkdir(parents=True, exist_ok=True)

    # 清空节点目录，避免 YAML 中节点 ID 变更导致重复文件累积
    for dir_path in [code_dir, prompts_dir, agents_dir, templates_dir]:
        for f in dir_path.iterdir():
            if f.is_file():
                try:
                    f.unlink()
                except OSError:
                    pass  # 文件被占用时跳过

    print("正在读取 YAML 文件...")
    with open(yaml_file, 'r', encoding='utf-8') as f:
        workflow_data = yaml.safe_load(f)

    workflow = workflow_data.get('workflow', {})
    graph_data = workflow.get('graph', {})
    nodes = graph_data.get('nodes', [])
    edges = graph_data.get('edges', [])

    print(f"找到 {len(nodes)} 个节点，{len(edges)} 条边")

    node_map = build_node_map(nodes)
    graph = build_connection_graph(edges, node_map)

    code_files = []
    prompt_files = []
    agent_files = []
    template_files = []

    print("正在提取代码节点...")
    for node in nodes:
        file_path = extract_code_node(node, code_dir)
        if file_path:
            code_files.append(file_path)
    print(f"提取了 {len(code_files)} 个代码节点")
    
    print("正在提取 Agent 节点...")
    for node in nodes:
        file_path = extract_agent_node(node, agents_dir)
        if file_path:
            agent_files.append(file_path)
            
    print(f"提取了 {len(agent_files)} 个 Agent 节点")
    
    print("正在提取 Prompt 节点...")
    for node in nodes:
        file_path = extract_prompt_node(node, prompts_dir)
        if file_path:
            prompt_files.append(file_path)
    print(f"提取了 {len(prompt_files)} 个 Prompt 节点")

    print("正在提取模板节点...")
    for node in nodes:
        file_path = extract_template_node(node, templates_dir)
        if file_path:
            template_files.append(file_path)
    print(f"提取了 {len(template_files)} 个模板节点")

    print("正在生成 README.md...")
    readme_content = generate_readme(workflow_data, node_map, graph, code_files, prompt_files, agent_files, template_files)
    readme_path = workspace_dir / "README.md"
    readme_path.write_text(readme_content, encoding='utf-8')

    print("正在生成工作流结构文档...")
    structure_content = generate_structure_doc(workflow_data, node_map, graph)
    structure_path = docs_dir / "workflow_structure.md"
    structure_path.write_text(structure_content, encoding='utf-8')

    print("导入完成！")
    print(f"- 代码节点: {len(code_files)} 个, Agent: {len(agent_files)} 个, Prompt: {len(prompt_files)} 个, 模板: {len(template_files)} 个")
    return True


def main():
    """主函数"""
    # 强制设置标准输出编码为 utf-8，解决 Windows 下中文输出报错问题
    if sys.stdout.encoding != 'utf-8':
        try:
            sys.stdout.reconfigure(encoding='utf-8')
        except AttributeError:
            pass  # Python < 3.7 可能不支持 reconfigure

    import argparse
    
    parser = argparse.ArgumentParser(description='Dify Workflow Importer')
    parser.add_argument('yaml_file', nargs='?', help='Path to the YAML file')
    parser.add_argument('--scheduler-agent', action='store_true', help='Update all scheduler_agent workflows')
    args = parser.parse_args()

    # 批量导入 scheduler_agent 下所有工作流
    if args.scheduler_agent:
        base_dir = Path(__file__).parent.parent / "scheduler_agent"
        yaml_files = list(base_dir.rglob("*.yml"))
        if not yaml_files:
            print("未找到 scheduler_agent 下的 YAML 文件")
            return
        print(f"找到 {len(yaml_files)} 个工作流文件，开始导入...\n")
        for yf in sorted(yaml_files):
            rel = yf.relative_to(base_dir.parent)
            print(f"\n=== {rel} ===")
            run_import(yf)
        print("\n全部导入完成！")
        return

    # 单文件导入
    if args.yaml_file:
        yaml_file = Path(args.yaml_file)
    else:
        # 默认回退到旧逻辑（为了兼容性）
        yaml_file = Path(__file__).parent / "托育 - 产业分析智能体(ceshi).yml"

    run_import(yaml_file)


if __name__ == "__main__":
    main()

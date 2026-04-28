本 agent 不需要工具。基于 prompt 推理输出 patches JSON。

如果用户指令需要先看现状（如「把那道关于 PID 的题改一下」），由 director 在 spawn 时把当前 dsl 注入 prompt 即可，本 agent 不主动读文件。

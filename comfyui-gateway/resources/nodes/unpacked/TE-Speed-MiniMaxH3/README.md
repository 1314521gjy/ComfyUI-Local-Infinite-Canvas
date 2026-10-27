# TE-Speed-MiniMaxH3  3.5

MiniMax H3 专用推理加速节点，面向视频与原生音频联合生成场景。
B站:TETAE

TE-Speed从2.0开始不再以加速时间为第一标准,而是速度质量兼顾


## 3.5 — 新版 ComfyUI H3 接口与 Comfy Compiler 兼容适配

适配官方新版 ComfyUI H3 接口,请更新至 ComfyUI 最新版使用.

- 适配官方新版 ComfyUI H3 ControlNet / Block Patch  接口。
- 适配官方新版 ComfyUI `Block Sparse Attention`节点。
- 适配官方新版 ComfyUI Comfy Compiler / `aimdo` 的 内存分配优化。


## 3.3 — 新版 ComfyUI PDD LoRA / Alibaba Acc LoRA 支持

适配新版 ComfyUI H3 接口,请更新至ComfyUI 最新版使用.
适配新版 ComfyUI 对 MiniMax H3 的 **PDD（Parallel Decoding Distillation，并行解码蒸馏）** 支持。
Alibaba 的 [MiniMax-H3-Acc-LoRAs]就是采用 PDD 方式训练的官方加速 LoRA。
TE-Speed 3.3 已完成对应适配,兼容新版接口，并保留旧版数接口兼容性。



## 3.2 — 新版 ComfyUI H3 / 8步Lora 适配/新增八步模式

请更新至ComfyUI最新版使用.
新版 ComfyUI 更新了 MiniMax H3 的执行与显存调度方式提高原生 H3 的权重调度和 Attention 效率，TE-Speed 3.2 针对新版执行机制进行了重新适配.
- 适配新版 ComfyUI block prefetch。
- 新增长视频(10s以上自动启用)缓存策略。
- CPU residual 改为分块传输和应用。
- 4/8 步 模式减少显存占用。
- 建议 `device` 选择 `auto`，由 TE-Speed 根据缓存自动调整策略。
- 提供KJ的sol修改版,支持和TE-Speed同时启用!速度再涨一节.

## 3.0 — 4-Step LoRA

4-Step LoRA 模式针对 MiniMax H3 的 4 步蒸馏 LoRA 和短采样轨迹进行了专项适配。节点会根据实际采样步数自动选择内部策略，对 H3 短轨迹的 sigma 间隔、缓存窗口和连续复用次数进行专门控制，以尽量保持画面、动作和音频特征。

- 1～10 步：在选择 `4-step LoRA` 时使用 4 步专用策略，优先控制短轨迹。
- 11 步及以上：自动使用标准长采样加速策略。
- Standard 模式：不自动切换，始终使用标准长采样加速策略。

(注:请使用kj的1.8G的4步lora,升级comfyui至最新版使用comfyui官方lora加载节点加载lora)



## 2.1 — Standard / 20-Step

1.0 是面向普通 H3 长采样流程的标准加速模式，适合约 20 步及相近配置。

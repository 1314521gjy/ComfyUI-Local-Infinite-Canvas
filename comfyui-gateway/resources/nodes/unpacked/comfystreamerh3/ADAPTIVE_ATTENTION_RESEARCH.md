# Adaptive attention: evidence summary

This note summarizes prior work relevant to the [experiment plan](ADAPTIVE_ATTENTION_PLAN.md). It distinguishes published results from questions that still require measurement in FastH3.

## What prior work supports

| Work | Relevant result | Limit for this experiment |
|---|---|---|
| [VSA](https://arxiv.org/abs/2505.13389v5) | Ranks video key/value cubes for each query cube and head, using a fixed Top-K budget and a coarse global branch. | Does not test variable attention counts per query in this node. |
| [DSV](https://arxiv.org/abs/2502.07590v3) | Uses learned query/key predictors and overhead-aware sparse dispatch in video diffusion. | Does not establish this node's per-query budget policy or kernel speed. |
| [BEV dynamic token halting](https://arxiv.org/abs/2303.05078v2) | Predicts whether spatial tokens continue through later detection layers. | Detection features/objectives do not directly transfer to denoising latents. |
| [DyDiT](https://arxiv.org/abs/2410.03456v2) | Allocates computation spatially and by denoising timestep. | Its spatial router skips MLP work, not attention keys. |
| [RegenHance](https://arxiv.org/abs/2407.16990v6) | Predicts which regions benefit from additional enhancement work. | Its decoded-image analytics objective differs from latent attention. |
| [DynamicRad](https://arxiv.org/html/2604.20470v1) | Uses prompt embeddings to choose a video-level sparsity regime. | A once-per-video router does not establish the cost of per-region, per-layer decisions. |
| [HEART](https://arxiv.org/html/2605.14513v2) | Calibrates attention budgets using denoising-velocity error and discusses mask reuse. | Supports end-to-end replay as a validation need; it does not validate a FastH3 controller. |
| [SVG2](https://arxiv.org/html/2505.18875v5) and [implementation](https://github.com/svg-project/Sparse-VideoGen) | Selects variable numbers of blocks per query cluster and executes variable-sized blocks. | Algorithm and kernel results on other models/hardware do not establish a win on FastH3. |
| [LoSA](https://arxiv.org/html/2608.12032) | Reports higher retained attention mass for an adaptive policy at matched average coverage; also reports end-to-end results on Wan. | Attention-mass recall is not a matched-latency generated-video quality result for this node. |

## Implications

- Adaptive allocation is plausible, but the open question is whether equal-budget redistribution improves FastH3 outputs at equal measured latency.
- A policy must preserve every query output, prefix conditioning, the trained coarse contribution, padding, and coordinate restoration.
- Local attention-output error is insufficient evidence. Candidate decisions must be replayed through later layers and denoising evaluations, followed by paired clip review.
- Fewer selected keys only help if the GPU kernel skips their loads and dot products. Feature extraction, selection, packing, launches, and padded work all count toward the result.
- A pretrained Bev model is not a ready-made latent-region controller. The two candidate releases previously identified were [avbiswas/bev-decider-0.4B](https://huggingface.co/avbiswas/bev-decider-0.4B) and [Reza2kn/Bev](https://huggingface.co/Reza2kn/Bev); the intended release remains unspecified in these notes. Neither cited model description establishes a native H3 latent input or a per-region attention policy.

## FastH3-specific unknowns

The checked-in source has fixed-count cube ranking and an H3 coarse branch, but the installed production kernel's variable-count interface and cost remain to be qualified. The baseline policy is marked `awaiting_gpu_evidence`. No paper result here establishes a FastH3 quality, latency, or memory improvement. See the [experiment summary](ADAPTIVE_ATTENTION_PLAN.md) for the proposed qualification sequence and gates.

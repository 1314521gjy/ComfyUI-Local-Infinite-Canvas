// SPDX-License-Identifier: Apache-2.0
#pragma once
#include <cuda_runtime.h>
#include <cstdint>
void launch_vc_group_prepare(const void*, const void*, const void*, const void*,
    void*, void*, void*, void*, void*, void*, void*, void*, const void*,
    int, int, int, int, int, int, int, int, int, int, cudaStream_t);
void launch_vc_group_fine(const void*, const void*, const void*, const void*, const void*,
    const void*, const void*, const void*, const void*, const void*, const void*,
    const void*, const void*, const void*, const void*, const void*, const void*,
    const void*, void*, int, int, int, int, float, int, int, int, int, int, cudaStream_t);
void launch_original_route_scores(const void*, const void*, const void*, const void*, void*,
    int, int, int, float, cudaStream_t);
cudaError_t vc_group_prepare_attributes(cudaFuncAttributes*);
cudaError_t vc_group_fine_attributes(cudaFuncAttributes*, int);

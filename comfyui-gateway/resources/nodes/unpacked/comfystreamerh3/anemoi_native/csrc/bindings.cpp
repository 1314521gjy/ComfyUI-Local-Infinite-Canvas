#include <torch/extension.h>
#include <vector>

using T = torch::Tensor;
using Output = std::tuple<T,T>;
void prepare_int8_chunk(T,T,T,T,T,T,T,T,T,T,T,int64_t,bool,int64_t,T,int64_t,T);
void prepare_int8_chunk_ragged(T,T,T,T,T,T,T,T,T,T,T,int64_t,bool,int64_t,T,int64_t,T);
void prepare_nvfp4_chunk(T,T,T,T,T,T,T,T,T,T,T,T,T,int64_t,T,T);
void prepare_nvfp4_chunk_ragged(T,T,T,T,T,T,T,T,T,T,T,T,T,int64_t,T,T);
using V = std::vector<T>;
void prepare_mixed_nvfp4_chunk(V,T,V,V,V,T,int64_t,T,T);
void prepare_mixed_combined_chunk(V,T,V,V,V,T,int64_t,int64_t,int64_t,T,T);
Output int8_attention(T,T,T,T,T,T,T,T,T,T,double,bool,T,T);
Output combined_attention(T,T,T,T,T,T,T,T,T,T,double,bool,T,T);
Output fp16_attention(T,T,T,T,T,T,double,bool);
Output nvfp4_attention(T,T,T,T,T,T,T,T,T,T,T,T,double,bool);
std::vector<int64_t> int8_resources();
std::vector<int64_t> combined_resources();
std::vector<int64_t> fp16_resources();
std::vector<int64_t> nvfp4_resources();
void prepare_combined_nvfp4_chunk(T,T,T,T,T,T,T,T,T,T,T,T,T,T,int64_t,int64_t,int64_t,T,T);
void prepare_combined_nvfp4_chunk_ragged(T,T,T,T,T,T,T,T,T,T,T,T,T,T,int64_t,int64_t,int64_t,T,T);
Output mixed_attention(V,V,V,T,T,T,T,T,T,V,double,bool,T,T);
Output combined_mixed_attention(V,V,V,T,T,T,T,T,T,V,double,bool,T,T);
std::vector<int64_t> mixed_resources(bool);
std::vector<int64_t> combined_mixed_resources(bool);
Output combined_g4_attention(T,T,T,T,T,T,T,T,T,T,double,bool,T,T);
std::vector<int64_t> combined_g4_resources();
Output combined_mixed_g4_attention(V,V,V,T,T,T,T,T,T,V,double,bool,T,T);
std::vector<int64_t> combined_mixed_g4_resources(bool);
std::tuple<T,T,T,T> phase_assign(T,T,T,std::vector<double>);
std::tuple<T,T,T,T> phase_assign_optimized(T,T,T,std::vector<double>);
std::tuple<T,T,T,T,T> mixed_attention_with_phase(
    V,V,V,T,T,T,T,V,double,bool,T,T,std::vector<double>,T,bool,bool);
std::tuple<T,T,T,T,T> mixed_attention_with_phase_optimized(
    V,V,V,T,T,T,T,V,double,bool,T,T,std::vector<double>,T,bool,bool);
T output_epilogue(T,T,T,int64_t);
T output_epilogue_prefix(T,T,T,int64_t,T,int64_t,int64_t);
void measure_chunk(T,T,T,T,T,T,T);
V gather_grouped_chunk(T,T,T,T);

void prepare_mixed_nvfp4_chunk(
    V qkv, T valid, V i8, V nv, V global, T int8_global, int64_t offset,
    T clipping, T observed) {
  TORCH_CHECK(qkv.size() == 3 && i8.size() == 7 && nv.size() == 6 && global.size() == 3,
              "mixed preparation requires qkv, seven INT8, six NVFP4, and three global tensors");
  const auto empty = qkv[0].new_empty({0});
  prepare_int8_chunk(
      qkv[0], qkv[1], qkv[2], valid,
      i8[0], i8[1], i8[2], i8[3], i8[4], i8[5], i8[6],
      offset, false, 0, int8_global, 0, empty);
  prepare_nvfp4_chunk(
      qkv[0], qkv[1], qkv[2], valid,
      nv[0], nv[1], nv[2], nv[3], nv[4], nv[5],
      global[0], global[1], global[2], offset, clipping, observed);
}

void prepare_mixed_nvfp4_chunk_ragged(
    V qkv, T valid, V i8, V nv, V global, T int8_global, int64_t offset,
    T clipping, T observed) {
  TORCH_CHECK(qkv.size() == 3 && i8.size() == 7 && nv.size() == 6 && global.size() == 3,
              "mixed ragged preparation requires qkv, seven INT8, six NVFP4, and three global tensors");
  const auto empty = qkv[0].new_empty({0});
  prepare_int8_chunk_ragged(qkv[0], qkv[1], qkv[2], valid,
      i8[0], i8[1], i8[2], i8[3], i8[4], i8[5], i8[6],
      offset, false, 0, int8_global, 0, empty);
  prepare_nvfp4_chunk_ragged(qkv[0], qkv[1], qkv[2], valid,
      nv[0], nv[1], nv[2], nv[3], nv[4], nv[5],
      global[0], global[1], global[2], offset, clipping, observed);
}

void prepare_mixed_combined_chunk(
    V qkv, T valid, V i8, V nv, V global, T external_means,
    int64_t offset, int64_t prefix_start, int64_t prefix_end,
    T clipping, T observed) {
  TORCH_CHECK(qkv.size() == 3 && i8.size() == 7 && nv.size() == 6 && global.size() == 3,
              "combined preparation requires qkv, seven INT8, six NVFP4, and three global tensors");
  const auto empty = qkv[0].new_empty({0});
  prepare_int8_chunk(
      qkv[0], qkv[1], qkv[2], valid,
      i8[0], i8[1], i8[2], i8[3], i8[4], i8[5], i8[6],
      offset, true, prefix_end, empty, prefix_start, external_means);
  prepare_combined_nvfp4_chunk(
      qkv[0], qkv[1], qkv[2], valid,
      nv[0], nv[1], nv[2], nv[3], nv[4], nv[5],
      global[0], global[1], global[2], i8[6],
      offset, prefix_start, prefix_end, clipping, observed);
}

void prepare_mixed_combined_chunk_ragged(
    V qkv, T valid, V i8, V nv, V global, T external_means,
    int64_t offset, int64_t prefix_start, int64_t prefix_end,
    T clipping, T observed) {
  TORCH_CHECK(qkv.size() == 3 && i8.size() == 7 && nv.size() == 6 && global.size() == 3,
              "combined ragged preparation requires qkv, seven INT8, six NVFP4, and three global tensors");
  const auto empty = qkv[0].new_empty({0});
  prepare_int8_chunk_ragged(qkv[0], qkv[1], qkv[2], valid,
      i8[0], i8[1], i8[2], i8[3], i8[4], i8[5], i8[6],
      offset, true, prefix_end, empty, prefix_start, external_means);
  prepare_combined_nvfp4_chunk_ragged(qkv[0], qkv[1], qkv[2], valid,
      nv[0], nv[1], nv[2], nv[3], nv[4], nv[5],
      global[0], global[1], global[2], i8[6],
      offset, prefix_start, prefix_end, clipping, observed);
}

PYBIND11_MODULE(TORCH_EXTENSION_NAME,m) {
  m.attr("abi_version")=4;
  m.attr("source_revision")="native-phase-output-v1";
  m.attr("supports_fused_phase")=true;
  m.attr("supports_phase_metadata_fusion")=true;
  m.attr("supports_output_epilogue")=true;
  m.attr("supports_output_layout_epilogue")=true;
  m.attr("supports_direct_prefix_output")=true;
  m.attr("supports_prepare_fusion")=true;
  m.attr("supports_ragged_prepare")=true;
  m.def("prepare_int8_chunk",&prepare_int8_chunk);
  m.def("prepare_int8_chunk_ragged",&prepare_int8_chunk_ragged);
  m.def("prepare_nvfp4_chunk",&prepare_nvfp4_chunk);
  m.def("prepare_nvfp4_chunk_ragged",&prepare_nvfp4_chunk_ragged);
  m.def("int8_attention",&int8_attention);
  m.def("combined_attention",&combined_attention);
  m.def("fp16_attention",&fp16_attention);
  m.def("nvfp4_attention",&nvfp4_attention);
  m.def("int8_resources",&int8_resources);
  m.def("combined_resources",&combined_resources);
  m.def("fp16_resources",&fp16_resources);
  m.def("nvfp4_resources",&nvfp4_resources);
  m.def("prepare_combined_nvfp4_chunk",&prepare_combined_nvfp4_chunk);
  m.def("prepare_combined_nvfp4_chunk_ragged",&prepare_combined_nvfp4_chunk_ragged);
  m.def("prepare_mixed_nvfp4_chunk",&prepare_mixed_nvfp4_chunk);
  m.def("prepare_mixed_nvfp4_chunk_ragged",&prepare_mixed_nvfp4_chunk_ragged);
  m.def("prepare_mixed_combined_chunk",&prepare_mixed_combined_chunk);
  m.def("prepare_mixed_combined_chunk_ragged",&prepare_mixed_combined_chunk_ragged);
  m.def("mixed_attention",&mixed_attention);
  m.def("combined_mixed_attention",&combined_mixed_attention);
  m.def("mixed_resources",&mixed_resources);
  m.def("combined_mixed_resources",&combined_mixed_resources);
  m.def("combined_g4_attention",&combined_g4_attention);
  m.def("combined_g4_resources",&combined_g4_resources);
  m.def("combined_mixed_g4_attention",&combined_mixed_g4_attention);
  m.def("combined_mixed_g4_resources",&combined_mixed_g4_resources);
  m.def("phase_assign",&phase_assign);
  m.def("phase_assign_optimized",&phase_assign_optimized);
  m.def("mixed_attention_with_phase",&mixed_attention_with_phase);
  m.def("mixed_attention_with_phase_optimized",&mixed_attention_with_phase_optimized);
  m.def("output_epilogue",&output_epilogue);
  m.def("output_epilogue_prefix",&output_epilogue_prefix);
  m.def("measure_chunk",&measure_chunk);
  m.def("gather_grouped_chunk",&gather_grouped_chunk);
}

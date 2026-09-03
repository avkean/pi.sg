#include <algorithm>
#include <array>
#include <cstring>
#include <limits>
#include <memory>
#include <vector>

#if defined(__linux__) && defined(__x86_64__) && (defined(__GNUC__) || defined(__clang__))
#include <immintrin.h>
#endif

#include "common.h"

#if defined(PI_NEURAL_FORCE_SCALAR) && defined(PI_NEURAL_FORCE_AVX2)
#error "Only one neural backend can be forced"
#endif

#if defined(PI_NEURAL_FORCE_AVX2) &&                                                   \
    !(defined(__linux__) && defined(__x86_64__) &&                                    \
      (defined(__GNUC__) || defined(__clang__)))
#error "The forced AVX2 backend requires Linux x64 with GCC or Clang"
#endif

namespace pi::predict {
namespace {

int16_t ReadSigned16(const uint8_t* data) {
  const uint16_t bits = Read16(data);
  return static_cast<int16_t>(int32_t(bits) - (bits & 0x8000 ? 65536 : 0));
}

int32_t ReadSigned32(const uint8_t* data) {
  const uint32_t bits = Read32(data);
  return static_cast<int32_t>(int64_t(bits) -
                              (bits & 0x80000000U ? (int64_t{1} << 32) : 0));
}

struct Reader {
  Bytes bytes;
  size_t at = 0;

  const uint8_t* Take(size_t length) {
    if (length > bytes.size - at) throw Error{"Truncated neural model"};
    const uint8_t* result = bytes.data + at;
    at += length;
    return result;
  }
};

struct Layer {
  uint32_t inputs = 0;
  uint32_t outputs = 0;
  std::vector<int8_t> weights;
  std::vector<int32_t> biases;
  std::vector<uint8_t> shifts;
  bool narrow = true;
};

template <typename T>
uint64_t Storage(const std::vector<T>& values) {
  return uint64_t(values.capacity()) * sizeof(T);
}

uint64_t Storage(const Layer& layer) {
  return Storage(layer.weights) + Storage(layer.biases) + Storage(layer.shifts);
}

struct Model {
  napi_env env;
  uint32_t context = 0;
  uint32_t embedding = 0;
  std::vector<int16_t> embeddings;
  Layer first, second, output;
  std::vector<uint32_t> lut;
  std::vector<int16_t> input, hidden_first, hidden_second;
  std::array<int16_t, kSymbols> logits{};
  int64_t external = 0;

  explicit Model(napi_env environment) : env(environment) {}

  ~Model() {
    if (external) {
      int64_t adjusted;
      CheckCleanup(napi_adjust_external_memory(env, -external, &adjusted));
    }
  }

  uint64_t StorageBytes() const {
    return Storage(embeddings) + Storage(first) + Storage(second) + Storage(output) +
           Storage(lut) + Storage(input) + Storage(hidden_first) + Storage(hidden_second);
  }
};

struct Addon {
  Reference buffer_prototype;
  std::unique_ptr<Model> model;

  explicit Addon(napi_env env) : buffer_prototype(env) {}
};

template <size_t Count>
Addon& Arguments(napi_env env, napi_callback_info info, napi_value (&args)[Count]) {
  size_t argc = Count;
  void* data = nullptr;
  Check(napi_get_cb_info(env, info, &argc, args, nullptr, &data));
  if (argc != Count) throw Error{"Wrong number of arguments", true};
  if (!data) throw Error{"Missing neural predictor state"};
  return *static_cast<Addon*>(data);
}

Layer ReadLayer(Reader& reader, uint32_t outputs, uint32_t inputs,
                const std::vector<uint32_t>& bounds) {
  Layer layer;
  layer.inputs = inputs;
  layer.outputs = outputs;
  const size_t weight_count = size_t(inputs) * outputs;
  const uint8_t* weights = reader.Take(weight_count);
  layer.weights.resize(weight_count);
  for (size_t i = 0; i < weight_count; ++i) {
    layer.weights[i] =
        static_cast<int8_t>(int16_t(weights[i]) - (weights[i] & 0x80 ? 256 : 0));
  }
  const uint8_t* biases = reader.Take(size_t(outputs) * 4);
  layer.biases.resize(outputs);
  for (uint32_t i = 0; i < outputs; ++i) {
    layer.biases[i] = ReadSigned32(biases + size_t(i) * 4);
  }
  const uint8_t* shifts = reader.Take(outputs);
  layer.shifts.assign(shifts, shifts + outputs);
  for (uint32_t i = 0; i < outputs; ++i) {
    if (layer.shifts[i] > 30) throw Error{"Invalid neural shift"};
    uint64_t bound = 0;
    for (uint32_t j = 0; j < inputs; ++j) {
      const int32_t weight = layer.weights[size_t(i) * inputs + j];
      bound += uint64_t(weight < 0 ? -weight : weight) * bounds[j];
    }
    // Sum of absolute products bounds every partial sum, including SIMD groups.
    // The frozen model passes this test for every row of all three layers.
    if (bound > uint64_t(std::numeric_limits<int32_t>::max())) layer.narrow = false;
  }
  return layer;
}

std::unique_ptr<Model> Parse(napi_env env, Bytes bytes) {
  if (bytes.size < 32) throw Error{"Invalid neural model length"};
  Reader reader{bytes};
  std::array<uint32_t, 8> header;
  const uint8_t* raw_header = reader.Take(32);
  for (size_t i = 0; i < header.size(); ++i) header[i] = Read32(raw_header + i * 4);
  const uint32_t context = header[0], embedding = header[1];
  const uint32_t first = header[2], second = header[3];
  if (!context || context > 64 || !embedding || embedding > 32 || !first ||
      first > 2048 || !second || second > 2048 || header[4] != kSymbols ||
      header[5] != 512 || header[6] != 8191 || header[7] != 8193) {
    throw Error{"Invalid neural model dimensions"};
  }
  // Widen before multiplication; the dimension caps also bound all allocations.
  const uint64_t expected =
      32 + uint64_t(2) * kSymbols * embedding + uint64_t(first) * context * embedding +
      uint64_t(5) * first + uint64_t(second) * first + uint64_t(5) * second +
      uint64_t(kSymbols) * second + uint64_t(5) * kSymbols + uint64_t(4) * 8193;
  if (expected != bytes.size) throw Error{"Invalid neural model length"};

  auto model = std::make_unique<Model>(env);
  model->context = context;
  model->embedding = embedding;
  model->embeddings.resize(kSymbols * embedding);
  const uint8_t* embeddings = reader.Take(model->embeddings.size() * 2);
  std::vector<uint32_t> bounds(size_t(context) * embedding, 0);
  for (size_t i = 0; i < model->embeddings.size(); ++i) {
    const int32_t value = ReadSigned16(embeddings + i * 2);
    model->embeddings[i] = static_cast<int16_t>(value);
    const uint32_t magnitude = static_cast<uint32_t>(value < 0 ? -value : value);
    bounds[i % embedding] = std::max(bounds[i % embedding], magnitude);
  }
  for (size_t i = embedding; i < bounds.size(); ++i) bounds[i] = bounds[i % embedding];
  model->first = ReadLayer(reader, first, context * embedding, bounds);
  bounds.assign(first, 8191);
  model->second = ReadLayer(reader, second, first, bounds);
  bounds.assign(second, 8191);
  model->output = ReadLayer(reader, kSymbols, second, bounds);
  const uint8_t* lut = reader.Take(size_t(8193) * 4);
  model->lut.resize(8193);
  for (size_t i = 0; i < model->lut.size(); ++i) model->lut[i] = Read32(lut + i * 4);
  // A maximum logit always uses entry zero, making the denominator nonzero.
  if (!model->lut[0]) throw Error{"Invalid neural lookup table"};
  if (reader.at != bytes.size) throw Error{"Invalid neural model length"};

  model->input.resize(size_t(context) * embedding);
  model->hidden_first.resize(first);
  model->hidden_second.resize(second);
  return model;
}

napi_value Load(napi_env env, napi_callback_info info) {
  return Guard(env, [&]() {
    napi_value args[1];
    Addon& addon = Arguments(env, info, args);
    auto next = Parse(env, GetBuffer(env, args[0], addon.buffer_prototype.value));
    napi_value result;
    Check(napi_get_undefined(env, &result));
    const uint64_t used = next->StorageBytes();
    if (used > uint64_t(std::numeric_limits<int64_t>::max())) {
      throw Error{"Neural model is too large"};
    }
    int64_t adjusted;
    Check(napi_adjust_external_memory(env, static_cast<int64_t>(used), &adjusted));
    next->external = static_cast<int64_t>(used);
    addon.model.swap(next);
    return result;
  });
}

int16_t Activate(int64_t sum, int32_t bias, uint8_t shift, bool relu) {
  // Widen rounding and bias addition even when the dot product fits int32.
  const int64_t divisor = int64_t{1} << shift;
  const int64_t rounded = (sum >= 0 ? sum + divisor / 2 : sum - divisor / 2) / divisor;
  return static_cast<int16_t>(
      std::clamp<int64_t>(rounded + bias, relu ? 0 : -32767, relu ? 8191 : 32767));
}

template <typename Accumulator>
void Linear(const Layer& layer, const int16_t* input, int16_t* output, bool relu) {
  for (uint32_t i = 0; i < layer.outputs; ++i) {
    Accumulator sum = 0;
    const int8_t* weights = layer.weights.data() + size_t(i) * layer.inputs;
    for (uint32_t j = 0; j < layer.inputs; ++j) {
      sum += int32_t(weights[j]) * input[j];
    }
    output[i] = Activate(sum, layer.biases[i], layer.shifts[i], relu);
  }
}

#if defined(__linux__) && defined(__x86_64__) && (defined(__GNUC__) || defined(__clang__))
__attribute__((target("avx2"))) void LinearAvx2(const Layer& layer, const int16_t* input,
                                                int16_t* output, bool relu) {
  // Reuse each input load across four rows. The validated absolute-product
  // bound covers every lane sum and the horizontal reductions.
  uint32_t i = 0;
  for (; i + 4 <= layer.outputs; i += 4) {
    const int8_t* weights = layer.weights.data() + size_t(i) * layer.inputs;
    __m256i sums[4] = {_mm256_setzero_si256(), _mm256_setzero_si256(),
                       _mm256_setzero_si256(), _mm256_setzero_si256()};
    uint32_t j = 0;
    for (; j + 16 <= layer.inputs; j += 16) {
      const __m256i values =
          _mm256_loadu_si256(reinterpret_cast<const __m256i*>(input + j));
      for (uint32_t row = 0; row < 4; ++row) {
        const __m128i packed = _mm_loadu_si128(
            reinterpret_cast<const __m128i*>(weights + size_t(row) * layer.inputs + j));
        const __m256i wide = _mm256_cvtepi8_epi16(packed);
        sums[row] = _mm256_add_epi32(sums[row], _mm256_madd_epi16(wide, values));
      }
    }
    for (uint32_t row = 0; row < 4; ++row) {
      __m128i combined = _mm_add_epi32(_mm256_castsi256_si128(sums[row]),
                                       _mm256_extracti128_si256(sums[row], 1));
      combined = _mm_hadd_epi32(combined, combined);
      combined = _mm_hadd_epi32(combined, combined);
      int32_t sum = _mm_cvtsi128_si32(combined);
      for (uint32_t tail = j; tail < layer.inputs; ++tail) {
        sum += int32_t(weights[size_t(row) * layer.inputs + tail]) * input[tail];
      }
      output[i + row] = Activate(sum, layer.biases[i + row], layer.shifts[i + row], relu);
    }
  }
  for (; i < layer.outputs; ++i) {
    const int8_t* weights = layer.weights.data() + size_t(i) * layer.inputs;
    __m256i sums = _mm256_setzero_si256();
    uint32_t j = 0;
    for (; j + 16 <= layer.inputs; j += 16) {
      const __m128i packed =
          _mm_loadu_si128(reinterpret_cast<const __m128i*>(weights + j));
      const __m256i wide = _mm256_cvtepi8_epi16(packed);
      const __m256i values =
          _mm256_loadu_si256(reinterpret_cast<const __m256i*>(input + j));
      sums = _mm256_add_epi32(sums, _mm256_madd_epi16(wide, values));
    }
    __m128i combined =
        _mm_add_epi32(_mm256_castsi256_si128(sums), _mm256_extracti128_si256(sums, 1));
    combined = _mm_hadd_epi32(combined, combined);
    combined = _mm_hadd_epi32(combined, combined);
    int32_t sum = _mm_cvtsi128_si32(combined);
    for (; j < layer.inputs; ++j) sum += int32_t(weights[j]) * input[j];
    output[i] = Activate(sum, layer.biases[i], layer.shifts[i], relu);
  }
}
#endif

void Linear(const Layer& layer, const int16_t* input, int16_t* output, bool relu) {
  if (layer.narrow) {
#if defined(PI_NEURAL_FORCE_SCALAR)
    Linear<int32_t>(layer, input, output, relu);
    return;
#elif defined(PI_NEURAL_FORCE_AVX2)
    static const bool avx2 = __builtin_cpu_supports("avx2");
    if (!avx2) throw Error{"AVX2 is unavailable"};
    LinearAvx2(layer, input, output, relu);
    return;
#elif defined(__linux__) && defined(__x86_64__) && \
    (defined(__GNUC__) || defined(__clang__))
    static const bool avx2 = __builtin_cpu_supports("avx2");
    if (avx2) {
      LinearAvx2(layer, input, output, relu);
      return;
    }
#endif
    Linear<int32_t>(layer, input, output, relu);
  } else {
    // With at most 2048 inputs, even 128 * 32768 per term fits int64 easily.
    Linear<int64_t>(layer, input, output, relu);
  }
}

napi_value Predict(napi_env env, napi_callback_info info) {
  return Guard(env, [&]() {
    napi_value args[2];
    Addon& addon = Arguments(env, info, args);
    const Bytes text = GetBuffer(env, args[0], addon.buffer_prototype.value);
    double* out = GetOutput(env, args[1]);
    if (!addon.model) throw Error{"No neural model loaded"};
    Model& model = *addon.model;
    // Calls are synchronous and worker-local, so scratch storage can be reused.
    for (uint32_t i = 0; i < model.context; ++i) {
      const size_t distance = model.context - i;
      const uint32_t symbol =
          text.size < distance ? 256 : text.data[text.size - distance];
      std::memcpy(model.input.data() + size_t(i) * model.embedding,
                  model.embeddings.data() + size_t(symbol) * model.embedding,
                  size_t(model.embedding) * sizeof(int16_t));
    }
    Linear(model.first, model.input.data(), model.hidden_first.data(), true);
    Linear(model.second, model.hidden_first.data(), model.hidden_second.data(), true);
    Linear(model.output, model.hidden_second.data(), model.logits.data(), false);
    const int32_t maximum = *std::max_element(model.logits.begin(), model.logits.end());
    std::array<uint32_t, kSymbols> values;
    uint64_t sum = 0;
    for (size_t i = 0; i < kSymbols; ++i) {
      const uint32_t difference =
          static_cast<uint32_t>((maximum - model.logits[i] + 1) / 2);
      values[i] = model.lut[std::min(uint32_t(8192), difference)];
      sum += values[i];
    }
    // 257 uint32 entries fit uint64 and remain exactly representable as doubles.
    for (size_t i = 0; i < kSymbols; ++i) out[i] = double(values[i]) / double(sum);
    return args[1];
  });
}

napi_value Init(napi_env env, napi_value exports) {
  return Guard(env, [&]() {
    CheckFloatingPoint();
    auto addon = std::make_unique<Addon>(env);
    napi_value global, buffer, prototype;
    Check(napi_get_global(env, &global));
    Check(napi_get_named_property(env, global, "Buffer", &buffer));
    Check(napi_get_named_property(env, buffer, "prototype", &prototype));
    Check(napi_create_reference(env, prototype, 1, &addon->buffer_prototype.value));

    // Keep both addon lifetimes independent, including when exports are collected.
    Check(napi_add_env_cleanup_hook(
        env, [](void* data) { delete static_cast<Addon*>(data); }, addon.get()));
    Addon* data = addon.release();
    const napi_property_descriptor properties[] = {
        {"load", nullptr, Load, nullptr, nullptr, nullptr, napi_default, data},
        {"predict", nullptr, Predict, nullptr, nullptr, nullptr, napi_default, data},
    };
    Check(napi_define_properties(env, exports, 2, properties));
    return exports;
  });
}

}  // namespace
}  // namespace pi::predict

NAPI_MODULE(NODE_GYP_MODULE_NAME, pi::predict::Init)

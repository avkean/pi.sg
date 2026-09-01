#include <algorithm>
#include <array>
#include <cstring>
#include <limits>
#include <memory>
#include <vector>

#include "common.h"

namespace pi::predict {
namespace {

uint64_t Read64(const uint8_t* data) {
  return uint64_t(Read32(data)) | (uint64_t(Read32(data + 4)) << 32);
}

struct Model {
  Reference buffer;
  Bytes bytes{};
  uint32_t order = 0;
  std::vector<uint64_t> keys;
  std::vector<uint32_t> offsets;
  int64_t external = 0;

  explicit Model(napi_env env) : buffer(env) {}

  ~Model() {
    if (external) {
      int64_t adjusted;
      CheckCleanup(napi_adjust_external_memory(buffer.env, -external, &adjusted));
    }
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
  if (!data) throw Error{"Missing context predictor state"};
  return *static_cast<Addon*>(data);
}

std::unique_ptr<Model> Parse(napi_env env, Bytes bytes) {
  if (bytes.size < 8 || bytes.size > std::numeric_limits<uint32_t>::max()) {
    throw Error{"Invalid context model length"};
  }
  const uint32_t order = Read32(bytes.data);
  const uint32_t count = Read32(bytes.data + 4);
  if (order > 16 || count > 3000000 || count > (bytes.size - 8) / 14) {
    throw Error{"Invalid context model dimensions"};
  }

  auto model = std::make_unique<Model>(env);
  model->bytes = bytes;
  model->order = order;
  model->keys.resize(count);
  model->offsets.resize(count);
  size_t at = 8;
  for (uint32_t i = 0; i < count; ++i) {
    if (bytes.size - at < 10) throw Error{"Truncated context record"};
    const uint64_t key = Read64(bytes.data + at);
    const uint16_t entries = Read16(bytes.data + at + 8);
    if (i && key <= model->keys[i - 1]) {
      throw Error{"Context keys must be strictly increasing"};
    }
    if (!entries || entries > kSymbols || entries > (bytes.size - at - 10) / 4) {
      throw Error{"Invalid context record length"};
    }
    model->keys[i] = key;
    model->offsets[i] = static_cast<uint32_t>(at + 8);
    at += 10;
    std::array<bool, kSymbols> seen{};
    for (uint16_t j = 0; j < entries; ++j, at += 4) {
      const uint16_t symbol = Read16(bytes.data + at);
      const uint16_t frequency = Read16(bytes.data + at + 2);
      if (symbol >= kSymbols || seen[symbol] || !frequency) {
        throw Error{"Invalid context symbol or count"};
      }
      seen[symbol] = true;
    }
  }
  if (at != bytes.size) throw Error{"Invalid context model length"};
  return model;
}

napi_value Load(napi_env env, napi_callback_info info) {
  return Guard(env, [&]() {
    napi_value args[1];
    Addon& addon = Arguments(env, info, args);
    auto next = Parse(env, GetBuffer(env, args[0], addon.buffer_prototype.value));
    Check(napi_create_reference(env, args[0], 1, &next->buffer.value));
    napi_value result;
    Check(napi_get_undefined(env, &result));

    // Account only the index; the retained Buffer owns the original model bytes.
    const uint64_t used = uint64_t(next->keys.capacity()) * sizeof(uint64_t) +
                          uint64_t(next->offsets.capacity()) * sizeof(uint32_t);
    if (used > uint64_t(std::numeric_limits<int64_t>::max())) {
      throw Error{"Context index is too large"};
    }
    int64_t adjusted;
    Check(napi_adjust_external_memory(env, static_cast<int64_t>(used), &adjusted));
    next->external = static_cast<int64_t>(used);
    addon.model.swap(next);
    return result;
  });
}

bool Overlaps(const void* a, size_t a_size, const void* b, size_t b_size) {
  const uintptr_t left = reinterpret_cast<uintptr_t>(a);
  const uintptr_t right = reinterpret_cast<uintptr_t>(b);
  return left <= right ? right - left < a_size : left - right < b_size;
}

napi_value Predict(napi_env env, napi_callback_info info) {
  return Guard(env, [&]() {
    napi_value args[2];
    Addon& addon = Arguments(env, info, args);
    const Bytes text = GetBuffer(env, args[0], addon.buffer_prototype.value);
    double* out = GetOutput(env, args[1]);
    if (!addon.model) throw Error{"No context model loaded"};
    const Model& model = *addon.model;

    // A strong reference prevents GC, but not an explicit detach or resize.
    napi_value retained;
    Check(napi_get_reference_value(env, model.buffer.value, &retained));
    void* current = nullptr;
    size_t size = 0;
    Check(napi_get_buffer_info(env, retained, &current, &size));
    if (current != model.bytes.data || size != model.bytes.size) {
      throw Error{"Context model Buffer was detached or resized"};
    }
    if (Overlaps(out, kSymbols * sizeof(double), current, size)) {
      throw Error{"Output must not overlap the context model"};
    }

    std::array<double, kSymbols> probabilities{};
    std::array<bool, kSymbols> excluded{};
    double weight = 1;
    for (int n = static_cast<int>(model.order); n >= 0; --n) {
      uint64_t hash = 1469598103934665603ULL ^ uint64_t(n) * 0x9e3779b97f4a7c15ULL;
      for (int j = 0; j < n; ++j) {
        const size_t distance = static_cast<size_t>(n - j);
        hash ^= text.size < distance ? 0 : text.data[text.size - distance];
        hash *= 1099511628211ULL;
      }
      const auto found = std::lower_bound(model.keys.begin(), model.keys.end(), hash);
      if (found == model.keys.end() || *found != hash) continue;
      const size_t index = static_cast<size_t>(found - model.keys.begin());
      const size_t at = model.offsets[index];
      const uint16_t entries = Read16(model.bytes.data + at);
      const size_t end = index + 1 < model.offsets.size()
                             ? size_t(model.offsets[index + 1]) - 8
                             : model.bytes.size;
      // Recheck byte-derived indices so accidental mutation cannot access memory
      // outside a record or the probability arrays. JS keeps these bytes immutable.
      if (!entries || entries > kSymbols || size_t(entries) * 4 != end - at - 2) {
        throw Error{"Context model record changed"};
      }
      std::array<uint16_t, kSymbols> symbols, counts;
      std::array<bool, kSymbols> seen{};
      uint32_t total = 0;
      uint32_t types = 0;
      for (uint16_t i = 0; i < entries; ++i) {
        const uint8_t* pair = model.bytes.data + at + 2 + size_t(i) * 4;
        const uint16_t symbol = Read16(pair);
        const uint16_t count = Read16(pair + 2);
        if (symbol >= kSymbols || seen[symbol] || !count) {
          throw Error{"Context model symbol or count changed"};
        }
        seen[symbol] = true;
        symbols[i] = symbol;
        counts[i] = count;
        if (!excluded[symbol]) {
          total += count;
          ++types;
        }
      }
      // At most 257 distinct uint16 counts plus 257 escape counts fit uint32.
      if (!types) continue;
      for (uint16_t i = 0; i < entries; ++i) {
        const uint16_t symbol = symbols[i];
        if (!excluded[symbol]) {
          probabilities[symbol] = weight * counts[i] / (total + types);
          excluded[symbol] = true;
        }
      }
      weight *= double(types) / (total + types);
    }
    uint32_t remaining = 0;
    for (bool used : excluded) {
      if (!used) ++remaining;
    }
    for (size_t i = 0; i < kSymbols; ++i) {
      if (!excluded[i]) probabilities[i] = weight / remaining;
    }
    // Delay writes until all history reads and validation have completed.
    std::memcpy(out, probabilities.data(), sizeof(probabilities));
    return args[1];
  });
}

napi_value Init(napi_env env, napi_value exports) {
  return Guard(env, [&]() {
    auto addon = std::make_unique<Addon>(env);
    napi_value global, buffer, prototype;
    Check(napi_get_global(env, &global));
    Check(napi_get_named_property(env, global, "Buffer", &buffer));
    Check(napi_get_named_property(env, buffer, "prototype", &prototype));
    Check(napi_create_reference(env, prototype, 1, &addon->buffer_prototype.value));

    // Callback data is private to this addon and worker. Environment instance
    // data is shared with other addons, so it cannot own either predictor.
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

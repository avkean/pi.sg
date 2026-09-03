#pragma once

#include <node_api.h>

#include <cstddef>
#include <cfenv>
#include <cstdint>
#include <exception>
#include <limits>
#include <new>

namespace pi::predict {

constexpr size_t kSymbols = 257;

struct Error {
  const char* message;
  bool type = false;
};

static_assert(std::numeric_limits<double>::is_iec559);
static_assert(std::numeric_limits<double>::radix == 2);
static_assert(std::numeric_limits<double>::digits == 53);

inline void CheckFloatingPoint() {
  if (std::fegetround() != FE_TONEAREST) {
    throw Error{"Unsupported floating-point rounding mode"};
  }
}

inline void Check(napi_status status) {
  if (status != napi_ok) throw Error{"Node-API operation failed"};
}

inline void CheckCleanup(napi_status status) noexcept {
  if (status != napi_ok) {
    napi_fatal_error("pi predictor", NAPI_AUTO_LENGTH, "Node-API cleanup failed",
                     NAPI_AUTO_LENGTH);
  }
}

inline napi_value Throw(napi_env env, const Error& error) noexcept {
  bool pending = false;
  CheckCleanup(napi_is_exception_pending(env, &pending));
  if (!pending) {
    const napi_status status = error.type
                                   ? napi_throw_type_error(env, nullptr, error.message)
                                   : napi_throw_error(env, nullptr, error.message);
    if (status != napi_pending_exception) CheckCleanup(status);
  }
  return nullptr;
}

template <typename Function>
napi_value Guard(napi_env env, Function function) noexcept {
  try {
    return function();
  } catch (const Error& error) {
    return Throw(env, error);
  } catch (const std::bad_alloc&) {
    return Throw(env, {"Not enough memory for predictor model"});
  } catch (const std::exception&) {
    return Throw(env, {"Predictor model allocation failed"});
  } catch (...) {
    return Throw(env, {"Native predictor failed"});
  }
}

struct Reference {
  napi_env env;
  napi_ref value = nullptr;

  explicit Reference(napi_env environment) : env(environment) {}
  Reference(const Reference&) = delete;
  Reference& operator=(const Reference&) = delete;

  ~Reference() {
    if (value) CheckCleanup(napi_delete_reference(env, value));
  }
};

struct Bytes {
  const uint8_t* data;
  size_t size;
};

inline Bytes GetBuffer(napi_env env, napi_value value, napi_ref prototype) {
  bool is_buffer = false;
  Check(napi_is_buffer(env, value, &is_buffer));
  if (!is_buffer) throw Error{"Expected a Buffer", true};

  // Node-API also calls Uint8Arrays buffers; require the Buffer prototype.
  napi_value actual, expected;
  Check(napi_get_prototype(env, value, &actual));
  Check(napi_get_reference_value(env, prototype, &expected));
  bool same = false;
  Check(napi_strict_equals(env, actual, expected, &same));
  if (!same) throw Error{"Expected a Buffer", true};

  void* data = nullptr;
  size_t size = 0;
  napi_typedarray_type type;
  napi_value backing;
  Check(napi_get_typedarray_info(env, value, &type, &size, &data, &backing, nullptr));
  if (type != napi_uint8_array) throw Error{"Expected a Buffer", true};
  bool detached = false;
  Check(napi_is_detached_arraybuffer(env, backing, &detached));
  if (detached || (size && !data)) throw Error{"Buffer is detached"};
  return {static_cast<const uint8_t*>(data), size};
}

inline double* GetOutput(napi_env env, napi_value value) {
  bool typed = false;
  Check(napi_is_typedarray(env, value, &typed));
  if (!typed) throw Error{"Expected a Float64Array(257)", true};
  napi_typedarray_type type;
  size_t length = 0;
  void* data = nullptr;
  Check(napi_get_typedarray_info(env, value, &type, &length, &data, nullptr, nullptr));
  if (type != napi_float64_array || length != kSymbols || !data ||
      reinterpret_cast<uintptr_t>(data) % alignof(double) != 0) {
    throw Error{"Expected a Float64Array(257)", true};
  }
  return static_cast<double*>(data);
}

inline uint16_t Read16(const uint8_t* data) {
  return static_cast<uint16_t>(uint16_t(data[0]) | (uint16_t(data[1]) << 8));
}

inline uint32_t Read32(const uint8_t* data) {
  return uint32_t(data[0]) | (uint32_t(data[1]) << 8) | (uint32_t(data[2]) << 16) |
         (uint32_t(data[3]) << 24);
}

}  // namespace pi::predict

# Link formats

Pi stores the destination in the link, not in a database. Decoding must recover the original URL byte for byte. The HTTP redirect then uses normal URL serialization for its `Location` header.

A single literal `~` after the payload asks for a confirmation page instead of a redirect. It works with old links and both display alphabets. The suffix is outside the encoded data and counts toward the sharing limit. Only the server strips it, before decoding; codecs and their checksums are unchanged. The page shows the serialized address without fetching it and works without JavaScript.

## Compatibility

| Format                                                 | Code                              |
| ------------------------------------------------------ | --------------------------------- |
| Original P/S/D/L and compact arithmetic frames         | `codecs/core/`, `codecs/compact/` |
| `z`: byte-aligned URL structure                        | `src/structured.mjs`              |
| `x`: bit-packed URL structure and ordered query fields | `src/packed-structured.mjs`       |
| `y`: percent-escape transform and DEFLATE              | `src/percent.mjs`                 |
| `u`: Unicode and escaped-text compression              | `codecs/unicode/`                 |
| `w`: fixed domain ranks and URL grammar                | `codecs/grammar/`                 |
| `n`: byte context and word prediction                  | `codecs/predict/`                 |
| `o`: integer neural and byte context prediction        | `codecs/predict/`                 |

The `z/x/y/u/w/n/o` ASCII frames contain a marker and unpadded base64url of a four-byte CRC32 followed by the codec body. CRC32 catches accidental damage; it isn't authentication.

Generic Unicode transport packs the ASCII frame into 15-bit characters. Packed `x` frames also have a direct bit transport. The alphabet and framing rules are in `src/wide.mjs` and `src/native-frame.mjs`. Unicode normalization applies only to this outer representation, never to the destination.

`w` version 1 uses the fixed 262,144-domain dictionary. Its body starts with `0x10` for domain/tail coding or `0x11` for the typed-field model. `u` version 1 uses `0x10` for a whole stream or `0x11` for split URL text and character data.

`n` and `o` start their arithmetic stream with a one-bit choice: encode the complete URL, or encode a fixed domain rank and the remaining text. Both use the original context model and domain dictionary. `n` mixes these with an order-8 byte model and word counts; `o` uses a fixed integer predictor with 48 bytes of context. Their model files are in `models/predict-v1/`. The decoder checks the checksum, output limit, and canonical arithmetic stream. Native builds must not enable fast-math or floating-point contraction.

Keep model bytes, table order, codec settings, and old decoders intact. Several formats verify a link by re-encoding it, so changing an encoder can break existing links too. Use a new marker or version for incompatible changes. Model hashes are in `models/checksums.json`; saved outputs are in `test/fixtures/links.json` and `legacy-links.json`.

## Limits

- Input: 128 KiB. Model coding: 4 KiB. Extra server pass: 32 KiB.
- Generated URL: at most 8,192 characters after URL serialization, including the origin. Unicode falls back to ASCII if necessary.
- `u`: at most 6,128 body bytes and 128 KiB restored/transformed bytes. Brotli windows are capped at 17 bits; trailing compressed data is rejected.
- `w`: at most 6,145 body bytes and 4 KiB output. Arithmetic streams must be canonical.
- `n/o`: at most 2,048 ASCII characters; output is limited to 1,024 and 256 UTF-8 bytes respectively. The server stops searching after 18 ms and allows verification until 30 ms, keeping older candidates if either budget expires. These budgets don't change the format or its decoded output.
- Server compression: one worker, four queued jobs, a 50 ms job deadline, and ten admitted requests per second. Redirect decoding has a 300 ms deadline. Workers have a 128 MiB V8 heap budget; native allocations are separate.

The browser keeps its own result if the extra pass is unavailable or doesn't help. Neither server path fetches the destination.

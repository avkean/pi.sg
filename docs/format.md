# Link formats

Pi stores the destination in the link, not in a database. Decoding must recover the original URL byte for byte. The confirmation page uses normal URL serialization when it shows and opens the destination.

Every encoded link opens a confirmation page. A single literal `~` after the payload remains accepted for links made by older versions, but it no longer changes the behavior. The suffix is outside the encoded data. Only the server strips it before decoding, so codecs and their checksums are unchanged. The page shows the serialized address without fetching it and works without JavaScript.

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
| Mixed v1: fixed mixture with direct radix framing      | `codecs/mixed/`                   |

The `z/x/y/u/w/n/o` ASCII frames contain a marker and unpadded base64url of a four-byte CRC32 followed by the codec body. CRC32 catches accidental damage; it isn't authentication.

ASCII display may recode that frame with a 78-character path alphabet. It uses every character allowed in one URL path segment except `~`, which remains reserved for old links. `/`, `?`, `%`, and `#` are not used. The final character is always base64url so punctuation is not left at the end of a copied link. Pi uses this form only when it is shorter and contains a character outside base64url, which keeps it separate from older links.

Generic Unicode transport packs the ASCII frame into 15-bit characters. A denser version adds the remaining modern Hangul syllables and Yi syllables for a 39,921-character alphabet. It is used only when shorter and when at least one added character makes the format unambiguous. Packed `x` frames also keep their direct bit transport when that is shorter. Unicode normalization applies only to the outer representation, never to the destination.

The old and dense transport rules are in `src/wide.mjs`, `src/native-frame.mjs`, and `src/dense.mjs`. Their alphabets and root order are part of the format.

`w` version 1 uses the fixed 262,144-domain dictionary. Its body starts with `0x10` for domain/tail coding or `0x11` for the typed-field model. `u` version 1 uses `0x10` for a whole stream or `0x11` for split URL text and character data.

`n` and `o` start their arithmetic stream with a one-bit choice: encode the complete URL, or encode a fixed domain rank and the remaining text. Both use the original context model and domain dictionary. `n` mixes these with an order-8 byte model and word counts; `o` uses a fixed integer predictor with 48 bytes of context. Their model files are in `models/predict-v1/`. The decoder checks the checksum, output limit, and canonical arithmetic stream. Native builds must not enable fast-math or floating-point contraction.

Mixed v1 combines the `n` and `o` prediction families instead of choosing one for the whole link. A small fixed integer model decides their weight for each byte. It tries both a complete URL and a known-domain split, then maps the best arithmetic interval straight into the transport alphabet. This avoids the marker and byte padding used by older frames. Its fixed files are in `models/mixed-v1/`.

Mixed links use transport space that older Pi versions cannot emit. ASCII starts with one of `!$&'()*+,;=:@`, continues in radix 78, and ends in base64url. Unicode starts with one of 15,345 code points outside the older Pi prefixes, then continues in radix 39,921. The first character carries useful frame bits as well as identifying the format.

The Unicode frame protects the format version, source length, and source bytes with CRC-8/SAE-J1850. The ASCII frame uses a 13-bit CRC with polynomial `0x157f`. Both decoders rebuild the only canonical frame and reject any other spelling. These checks catch accidental damage; they are not authentication.

Keep model bytes, table order, codec settings, and old decoders intact. Several formats verify a link by re-encoding it, so changing an encoder can break existing links too. Use a new marker or version for incompatible changes. Model hashes are in `models/checksums.json`; saved outputs are in `test/fixtures/links.json` and `legacy-links.json`.

## Limits

- Input: 128 KiB. Model coding: 4 KiB. Extra server pass: 32 KiB.
- Generated URL: at most 8,192 characters after URL serialization, including the origin. Unicode falls back to ASCII if necessary.
- Dense transport: frames up to 2,048 characters. Longer frames keep the older base64url or Unicode transport.
- `u`: at most 6,128 body bytes and 128 KiB restored/transformed bytes. Brotli windows are capped at 17 bits; trailing compressed data is rejected.
- `w`: at most 6,145 body bytes and 4 KiB output. Arithmetic streams must be canonical.
- `n/o`: at most 2,048 ASCII characters; output is limited to 1,024 and 256 UTF-8 bytes respectively. These remain available as a fallback when mixed encoding cannot finish or the input is too long for it. Fallback search stops by 40 ms and verification by 48 ms.
- Mixed v1: at most 256 UTF-8 bytes of input, 820 Unicode characters, or 2,048 ASCII characters. Search stops after 45 ms. Redirect decoding shares the server's 300 ms deadline. If the encoder runs out of time, Pi keeps an older candidate.
- Server compression: one worker, four queued jobs, a 55 ms job deadline, and ten admitted requests per second. Redirect decoding has a 300 ms deadline. Workers have a 128 MiB V8 heap budget; native allocations are separate.

The browser keeps its own result if the extra pass is unavailable or doesn't help. Neither server path fetches the destination.

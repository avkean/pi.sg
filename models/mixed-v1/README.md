# MIXFRAME v1 models

These fixed files decide how much Pi should trust its statistical and neural predictors for each byte.

The models were trained from a deterministic 5,000-row sample of FineWeb URL metadata. Sampling used the seed `mixframe-v1`. The split used 4,478 rows for fitting and 522 rows for validation, selected by source index modulo 10. Model fitting used seed 193. Pi's development benchmarks, sealed holdout, and submitted links were not used for fitting.

Training corpus SHA-256:

```text
9c80d8eafebe46d8e668deb377ba73c368d45a6d32f3eecbb6a9fde80e244350
```

Original floating-point model SHA-256:

- Full URL: `8a6764a8bcbe18c3ca79bc4493a3d135a152e1de18e72fdcce3b5cb80b3f064d`
- Authority tail: `c55086979fd4fe0057cca9746934a460edcbab7273923b4640f6a6008e7f6d6d`

Training trace SHA-256:

- Full URL: `aa19ded9285bcb6b63920bd926ff4c58b108f391080bd1441f60a3a04d4a0355`
- Authority tail: `1c8137b920922ca6e47611fca4bb1ed532049a10ac8bf45d778b4575b32ab8d0`

The runtime files use deterministic integer inference. Their release hashes are pinned in [`../checksums.json`](../checksums.json).

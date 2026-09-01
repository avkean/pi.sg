# Credits

Pi uses [fflate](https://github.com/101arrowz/fflate) by Arjun Barrett, under the [MIT license](licenses/fflate-MIT.txt). Browser bundles retain its license notice. esbuild and Prettier are development tools with licenses included in their packages.

The domain dictionary is adapted from the [Majestic Million](https://majestic.com/reports/majestic-million) by Majestic 12, under [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). It contains the first 262,144 ranked domains from the August 31, 2026 list, packed into a fixed lookup table. The source and file hashes are retained in the model metadata.

The context and subword models use a fixed training set with SHA-256 `934894fd8e2b3d6abdf58e76c8d13555e3de3374da1749b29c2efbf6d3e28737`. The app doesn't train on submitted links.

The prediction models also use 300,000 URL records from [FineWeb](https://huggingface.co/datasets/HuggingFaceFW/fineweb) by Hugging Face, revision `9bb295ddab0e05d785b879661af7260fed5140fc`. FineWeb is available under [ODC-BY 1.0](https://opendatacommons.org/licenses/by/1-0/); rights in the underlying web content remain with its authors. Pi uses the URL metadata, not the page text. The extracted training set has SHA-256 `9c80d8eafebe46d8e668deb377ba73c368d45a6d32f3eecbb6a9fde80e244350`.

The word and bigram counts are derived from [text8](https://mattmahoney.net/dc/textdata.html), prepared by Matt Mahoney from English Wikipedia's March 2006 dump. Credit belongs to the Wikipedia contributors and Matt Mahoney. The source text's applicable Wikimedia licenses remain unchanged; these files contain word frequencies, not articles. The text8 input has SHA-256 `6e890197040d37d85beb962ae1f041ff1d9a9ca8d20c7d99c85027eebf51dca7`.

All deployed models are fixed files checked against `models/checksums.json`. Submitted links are never added to them.

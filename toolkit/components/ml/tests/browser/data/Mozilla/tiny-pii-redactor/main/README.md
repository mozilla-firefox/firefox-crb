# tiny-pii-redactor (test data)

Random-weight model for Firefox's ML engine tests (`moz-pii-token-labels`).
Not a real model: its labels are meaningless.

- Architecture: XLMRobertaForTokenClassification, hidden 16, 1 layer, 2 heads,
  same 23 BIO labels as mozilla/smart-pii-redactor.
- Tokenizer: the first 2000 pieces of that model's tokenizer; other text maps to <unk>.
  The normalizer's precompiled_charsmap is emptied (transformers.js applies NFKC itself).
- Weights: torch.manual_seed(0), q4 (MatMulNBits, block size 16), int8 embeddings.

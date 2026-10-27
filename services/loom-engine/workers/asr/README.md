# ASR worker: offline model migration

The manifest/parts protocol replaces silent 400,000-character / 2,000-segment
truncation. Legacy inline requests still work below the explicit 1 MiB response
limit; larger results return `output_requires_manifest` (413).

## Required migration for existing compose deployments

**Startup is not unchanged after this rebuild.** The former floating `small`
download at image build time has been removed. Enabling the legacy ASR compose
profile without provisioning a model now returns `model_lock_invalid` (503),
not an implicit network download. Add a read-only model mount and configure:

```text
ASR_MODEL_DIR=/models
ASR_MODEL_MANIFEST=/models/model-lock.json
HF_HUB_OFFLINE=1
```

Mount a directory containing `model.bin`, `config.json`, `tokenizer.json`,
`vocabulary.txt` and the operator-reviewed JSON lock. The lock records the exact
official repository, a 40-hex revision, file sizes and SHA-256 for **every** loaded
file. No `main` revision, symlink model files or automatic fallback is accepted.
`ASR_MODEL` is a diagnostic label only, not a model-download selector.

`model-lock.tiny.json` is the model used in the actual local synthetic smoke:
`Systran/faster-whisper-tiny` at
`d90ca5fe260221311c53c58e660288d3deb8d356` (MIT). Obtain its listed files from
`https://huggingface.co/Systran/faster-whisper-tiny/resolve/d90ca5fe260221311c53c58e660288d3deb8d356/<name>`
using an approved public download process, then copy the supplied lock to
`model-lock.json`. No platform credentials or private media are needed.

From this directory, the offline verification command is:

```sh
ASR_MODEL_DIR=/absolute/path/to/model \
ASR_MODEL_MANIFEST=/absolute/path/to/model/model-lock.json \
python -c 'from server import verified_model_directory; print(verified_model_directory()[1]["revision"])'
```

This verifier was run against the downloaded official tiny files and supplied
lock. The actual CPU model smoke also passed through this loader. Tiny is a
runtime test, **not** an industry accuracy recommendation: generated speech's
`dog` was recognized as `log`. For `small` or another model, an operator must
review and supply that model's exact revision/hash lock; it was not tested here.

The tested direct stack is pinned in `requirements-model.txt`. CTranslate2
4.5.0 requested an executable GNU stack and was rejected by this environment;
4.8.4 has an RW stack and ran without relaxing security. The Python base image
digest was registry-verified, but neither ASR nor video Docker image was built
or deployed. A release still needs full transitive SBOM and built-image digest.

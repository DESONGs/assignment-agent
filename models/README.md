# Local ASR Model Setup

This repository does not include local ASR model weights. The runtime expects
the default local model directory to be:

```text
models/Qwen3-ASR-1.7B-MLX-4bit
```

## Model Sources

- Recommended Apple Silicon / MLX 4-bit model:
  https://huggingface.co/mlx-community/Qwen3-ASR-1.7B-4bit
- Original Qwen release:
  https://huggingface.co/Qwen/Qwen3-ASR-1.7B

The project uses the MLX 4-bit model for the local Qwen3-ASR HTTP service. The
original Qwen model link is kept for provenance and license review.

## Install Guide

Run these commands from the repository root on an Apple Silicon Mac:

```bash
python3 -m venv .venv-qwen3-asr
.venv-qwen3-asr/bin/python -m ensurepip --upgrade
.venv-qwen3-asr/bin/python -m pip install -U pip
.venv-qwen3-asr/bin/python -m pip install mlx-qwen3-asr huggingface_hub
```

Download the MLX 4-bit model into the expected local directory:

```bash
.venv-qwen3-asr/bin/huggingface-cli download \
  mlx-community/Qwen3-ASR-1.7B-4bit \
  --local-dir models/Qwen3-ASR-1.7B-MLX-4bit
```

Start the local ASR HTTP service:

```bash
.venv-qwen3-asr/bin/python meeting-agent-pi-package/tools/local_asr_http_service.py \
  --host 127.0.0.1 \
  --port 8765 \
  --model-dir models/Qwen3-ASR-1.7B-MLX-4bit \
  --preload
```

Check service health:

```bash
python3 meeting-agent-pi-package/tools/local_asr_service_ctl.py status
```

## Runtime Notes

- Audio normalization happens before ASR. The ASR service receives normalized
  local WAV paths only.
- The ASR service is host-owned because MLX/Metal access is local to the Mac.
- Docker document workers do not receive audio files and do not run the ASR
  service.
- Keep downloaded model files out of git. The repository `.gitignore` excludes
  `models/` for that reason.

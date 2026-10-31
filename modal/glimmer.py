"""Muse Glimmer 30B (Meta open weights, Apache 2.0) served by vLLM on Modal.

The business's own GPU, not a shared API: after a booking, Glimmer writes the
technician's parts list and the customer's confirmation text from the call
evidence (src/afterBooking.js). OpenAI-compatible at /v1/chat/completions.

Spend guards (founder 2026-10-31: $30 of credits, use them wisely): one L40S,
one container at most, shuts down 2 minutes after the last request, weights
cached in a Volume so only the first start downloads them. FP8 on the fly fits
the 30B model plus its vision encoder in 48 GB.

Deploy:  modal deploy modal/glimmer.py
The endpoint key lives in the Modal secret "glimmer-key" (GLIMMER_API_KEY). Modal proxy auth is on:
without the Modal-Key/Modal-Secret headers a request never starts the GPU (red team #3: anyone with the
URL could otherwise keep the L40S running).
"""
import subprocess

import modal

MODEL = "meta-models/Muse-Glimmer-30B"
PORT = 8000

# CUDA devel base: vLLM's FlashInfer sampler compiles a kernel at start and needs nvcc
# (first deploy on debian_slim crashed with "Could not find nvcc", 10/31).
image = (
    modal.Image.from_registry("nvidia/cuda:12.8.1-devel-ubuntu22.04", add_python="3.12")
    .entrypoint([])
    .pip_install("vllm", "huggingface_hub[hf_transfer]")
    .env({"HF_HUB_ENABLE_HF_TRANSFER": "1", "HF_HOME": "/cache/hf", "VLLM_CACHE_ROOT": "/cache/vllm"})
)
cache = modal.Volume.from_name("glimmer-cache", create_if_missing=True)
app = modal.App("snap-glimmer")


@app.function(
    image=image,
    gpu="L40S",
    max_containers=1,
    scaledown_window=120,
    timeout=60 * 60,
    volumes={"/cache": cache},
    secrets=[modal.Secret.from_name("glimmer-key")],
)
@modal.concurrent(max_inputs=8)
@modal.web_server(port=PORT, startup_timeout=60 * 20, requires_proxy_auth=True)
def serve():
    import os

    subprocess.Popen([
        "vllm", "serve", MODEL,
        "--served-model-name", "muse-glimmer-30b",
        "--host", "0.0.0.0", "--port", str(PORT),
        "--quantization", "fp8",
        "--max-model-len", "16384",
        "--limit-mm-per-prompt", '{"image": 4}',
        "--gpu-memory-utilization", "0.92",
        "--api-key", os.environ["GLIMMER_API_KEY"],
    ])

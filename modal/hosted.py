"""The hosted judge copy: the same Node server (src/server.mjs) in one Modal container.

Judges open one private link (it carries the access code, given in the submission form, never in this
repo). Everything else is the app's own guards: the access-code gate, per-call tokens, per-place limits
and the session spend stop, which survives restarts because the ledger lives on a Modal Volume.

One container at most: calls live in memory, so a second container would split them. It scales to zero
15 minutes after the last request (a call lasts 15 minutes at most), so idle time costs nothing.

Deploy:  modal deploy modal/hosted.py
Keys come from the Modal secret "snap-hosted" (META_API_KEY, DEEPGRAM_API_KEY, ACCESS_CODE and the
Glimmer endpoint), created from a local file that is never committed.

Prompt Guard 2 (86M) runs beside Node in the same container (modal/guard_server.py, 127.0.0.1:8090). Its
weights are gated, so they were downloaded once on the deploying machine and uploaded to the Modal Volume
"snap-guard-model" (modal volume put snap-guard-model <dir> /prompt-guard); no Hugging Face token goes to Modal,
and nothing large stays on the deploying machine.
"""
import subprocess
from pathlib import Path

import modal

ROOT = Path(__file__).resolve().parent.parent
PORT = 8080

image = (
    modal.Image.from_registry("node:22.23.4-slim", add_python="3.12")
    .entrypoint([])
    .pip_install("torch==2.5.1", index_url="https://download.pytorch.org/whl/cpu")
    .pip_install("transformers==4.46.3", "sentencepiece==0.2.0", "tiktoken==0.8.0", "protobuf==5.28.3")
    .add_local_file(ROOT / "modal" / "guard_server.py", "/app/guard_server.py")
    .add_local_file(ROOT / "package.json", "/app/package.json")
    .add_local_dir(ROOT / "src", "/app/src")
    .add_local_dir(ROOT / "public", "/app/public")
    .add_local_dir(ROOT / "data", "/app/data")
    .add_local_dir(ROOT / "kb", "/app/kb", ignore=["corpus/raw/**"])  # the raw manuals (114 MB) stay local
)
state = modal.Volume.from_name("snap-hosted-data", create_if_missing=True)
guard_model = modal.Volume.from_name("snap-guard-model", create_if_missing=True)
app = modal.App("snap-hosted")


@app.function(
    image=image,
    cpu=1.0,
    memory=3072,  # Node + the Prompt Guard sidecar (about 1.2 GB of weights)
    max_containers=1,
    scaledown_window=15 * 60,
    timeout=24 * 60 * 60,
    volumes={"/data": state, "/models": guard_model},
    secrets=[modal.Secret.from_name("snap-hosted")],
)
@modal.concurrent(max_inputs=200)
@modal.web_server(port=PORT, startup_timeout=60)
def serve():
    import os

    env = {
        **os.environ,
        "HOST": "0.0.0.0",
        "PORT": str(PORT),
        "TRUST_PROXY": "1",
        "DATA_DIR": "/data",
        "NODE_ENV": "production",
        "SPEND_STOP_USD": os.environ.get("SPEND_STOP_USD", "10"),
        "PROMPT_GUARD_URL": "http://127.0.0.1:8090",
    }
    subprocess.Popen(["python", "/app/guard_server.py"], cwd="/app")
    subprocess.Popen(["node", "src/server.mjs"], cwd="/app", env=env)


@app.function(image=image, cpu=1.0, memory=3072, timeout=600, volumes={"/models": guard_model})
def guard_selftest():
    """modal run modal/hosted.py::guard_selftest -> scores one plain and one injection line."""
    subprocess.run(["python", "/app/guard_server.py", "selftest"], cwd="/app", check=True)

"""
Export animetimm/convnextv2_huge.dbv4-full to an ONNX file that server/taggers.mjs
can load with no changes to its inference path.

Needs torch, timm, onnx and onnxruntime. ComfyUI's embedded python already has
all four; otherwise `pip install torch timm onnx onnxruntime`. Full procedure,
download included: docs/taggers-setup.md.

  python scripts/export-animetimm-onnx.py --src <downloaded model folder>

Why a wrapper rather than a plain timm export.

server/taggers.mjs was written against the WD v1.4/v3 ONNX files and its
contract is theirs, in three ways a bare timm export does not satisfy:

  1. It feeds  NHWC  float32 [1, size, size, 3], BGR, values left in 0-255.
     preprocess() in that file says so in as many words. timm models are NCHW,
     RGB, 0-1, and ImageNet-normalised.
  2. It reads the input size back out of the graph as
     `session.inputMetadata[0].shape[1]`. That is the height only when the
     layout is NHWC; on an NCHW graph it reads 3 and every image is resized to
     3x3.
  3. It thresholds the raw output as probabilities. The WD graphs end in a
     sigmoid; timm classifiers return logits, so a bare export would put every
     confidence on the wrong scale and quietly return almost nothing.

So the wrapper below takes the tensor taggers.mjs already produces and does the
channel flip, the transpose, the scaling, the normalisation and the sigmoid
inside the graph. The result is drop-in: point `model:` and `labels:` at it in
config/taggers.yaml and nothing else changes.

The normalisation constants are not invented - they are read from the model's
own preprocess.json, which is the file that shipped with the weights.
"""

import json
import sys
from pathlib import Path

import torch
import torch.nn as nn
import timm

import argparse
import shutil

# Paths were hard-coded to the owner's Windows box until 22 Sep 2026; now any
# install can run this. See docs/taggers-setup.md for the whole procedure.
_parser = argparse.ArgumentParser(description="Export animetimm ConvNeXtV2 to PromptForge's ONNX contract")
_parser.add_argument(
    "--src", required=True,
    help="folder holding the downloaded animetimm/convnextv2_huge.dbv4-full repo "
         "(config.json, preprocess.json, pytorch_model.bin, selected_tags.csv)",
)
_parser.add_argument(
    "--out-dir", default=str(Path(__file__).resolve().parent.parent / "taggers"),
    help="where the .onnx, .onnx.data and .csv go (default: <repo>/taggers)",
)
_args = _parser.parse_args()

SRC = Path(_args.src)
OUT_DIR = Path(_args.out_dir)
OUT = OUT_DIR / "animetimm-convnextv2-huge-dbv4.onnx"
LABELS = OUT_DIR / "animetimm-convnextv2-huge-dbv4.csv"

for need in ("config.json", "preprocess.json", "pytorch_model.bin", "selected_tags.csv"):
    if not (SRC / need).exists():
        sys.exit(f"{SRC / need} is missing - --src must be the downloaded model folder")

# torch.onnx.export writes tensors over 2GB as external data, and by default
# that means ONE FILE PER TENSOR - ~300 of them, named onnx__MatMul_1952 and
# such, dumped beside the model. It loads correctly but it is not something you
# can copy to another machine without losing a piece. So the export goes to a
# scratch directory and is then re-saved with all_tensors_to_one_file, leaving
# exactly two files: the graph and its weights.
TMP_DIR = OUT_DIR / "_export_tmp"
TMP = TMP_DIR / "model.onnx"

cfg = json.loads((SRC / "config.json").read_text(encoding="utf-8"))
pre = json.loads((SRC / "preprocess.json").read_text(encoding="utf-8"))

# Pull mean/std out of the model's own test-time pipeline rather than assuming
# the ImageNet defaults. They happen to be the ImageNet ones here, but reading
# them means a different animetimm checkpoint exports correctly too.
norm = next(s for s in pre["test"] if s["type"] == "normalize")
size = next(s for s in pre["test"] if s["type"] == "center_crop")["size"][0]

print(f"architecture : {cfg['architecture']}")
print(f"num_classes  : {cfg['num_classes']}")
print(f"input size   : {size}x{size}")
print(f"mean         : {norm['mean']}")
print(f"std          : {norm['std']}")

model = timm.create_model(
    cfg["architecture"],
    pretrained=False,
    num_classes=cfg["num_classes"],
    **cfg.get("model_args", {}),
)

state = torch.load(SRC / "pytorch_model.bin", map_location="cpu", weights_only=True)
missing, unexpected = model.load_state_dict(state, strict=False)
if missing or unexpected:
    print(f"WARNING missing={len(missing)} unexpected={len(unexpected)}")
    if missing:
        print("  missing[:5]   :", missing[:5])
    if unexpected:
        print("  unexpected[:5]:", unexpected[:5])
    # A head-shaped mismatch means the wrong architecture or num_classes, and
    # exporting it would produce a file that runs and returns nonsense.
    if any("head" in n for n in missing):
        sys.exit("FATAL: classifier head did not load - refusing to export")
model.eval()


class WdCompatible(nn.Module):
    """Presents a timm tagger through the interface WD ONNX files use."""

    def __init__(self, inner, mean, std):
        super().__init__()
        self.inner = inner
        self.register_buffer("mean", torch.tensor(mean).view(1, 3, 1, 1))
        self.register_buffer("std", torch.tensor(std).view(1, 3, 1, 1))

    def forward(self, x):
        # x arrives as taggers.mjs builds it: [N, H, W, 3], BGR, 0-255.
        x = x.flip(-1)                 # BGR -> RGB
        x = x.permute(0, 3, 1, 2)      # NHWC -> NCHW
        x = x / 255.0
        x = (x - self.mean) / self.std
        return torch.sigmoid(self.inner(x))


wrapped = WdCompatible(model, norm["mean"], norm["std"]).eval()

dummy = torch.rand(1, size, size, 3) * 255.0

with torch.no_grad():
    ref = wrapped(dummy)
print(f"torch output : {tuple(ref.shape)}  min={ref.min():.4f} max={ref.max():.4f}")
if ref.shape[1] != cfg["num_classes"]:
    sys.exit(f"FATAL: expected {cfg['num_classes']} classes, got {ref.shape[1]}")

import shutil

OUT_DIR.mkdir(parents=True, exist_ok=True)
if TMP_DIR.exists():
    shutil.rmtree(TMP_DIR)
TMP_DIR.mkdir(parents=True)

print(f"exporting -> {TMP}")

torch.onnx.export(
    wrapped,
    dummy,
    str(TMP),
    input_names=["input"],
    output_names=["output"],
    dynamic_axes={"input": {0: "batch"}, "output": {0: "batch"}},
    opset_version=17,
    dynamo=False,
)

import onnx

print("consolidating external data into a single .onnx.data ...")
loaded = onnx.load(str(TMP))          # pulls in the scattered tensor files
data_name = OUT.name + ".data"
for stale in (OUT, OUT.with_name(data_name)):
    if stale.exists():
        stale.unlink()
onnx.save_model(
    loaded,
    str(OUT),
    save_as_external_data=True,
    all_tensors_to_one_file=True,
    location=data_name,
    size_threshold=0,
)
shutil.rmtree(TMP_DIR)

graph_mb = OUT.stat().st_size / 1e6
data_mb = OUT.with_name(data_name).stat().st_size / 1e6
print(f"wrote {OUT.name} ({graph_mb:.1f} MB) + {data_name} ({data_mb:.1f} MB)")

# Parity check. An export that runs but disagrees with the torch model is the
# failure mode that would otherwise surface as "the tags got worse", months
# later and with nothing pointing here.
import numpy as np
import onnxruntime as ort

sess = ort.InferenceSession(str(OUT), providers=["CPUExecutionProvider"])
meta = sess.get_inputs()[0]
print(f"onnx input   : {meta.name} {meta.shape}")
got = sess.run(None, {meta.name: dummy.numpy()})[0]

delta = float(np.abs(got - ref.numpy()).max())
print(f"max |onnx - torch| = {delta:.3e}")
if delta > 1e-3:
    sys.exit("FATAL: onnx output diverges from torch - do not ship this file")

# shape[1] is what taggers.mjs reads to decide the resize target.
if meta.shape[1] != size:
    sys.exit(f"FATAL: shape[1] is {meta.shape[1]}, taggers.mjs would resize to that")

# The labels are the model's own selected_tags.csv, byte for byte - copied
# only once the export has passed, so a failed run leaves no half-set.
shutil.copyfile(SRC / "selected_tags.csv", LABELS)
print(f"wrote {LABELS.name} (copied from selected_tags.csv)")

print("OK - parity holds and the graph is NHWC, drop-in for server/taggers.mjs")

#!/usr/bin/env python3
"""Render bounded /3 mapping evidence as front, top and side PNGs."""
import argparse, json
from pathlib import Path
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from mpl_toolkits.mplot3d.art3d import Poly3DCollection
def load_obj(path):
    vertices, faces = [], []
    for line in path.open(encoding="utf-8"):
        fields = line.split()
        if fields and fields[0] == "v": vertices.append([float(x) for x in fields[1:4]])
        elif fields and fields[0] == "f": faces.append([int(x.split("/")[0])-1 for x in fields[1:]])
    return np.asarray(vertices, dtype=float), faces
def decode(prefix, depth):
    xyz = [0, 0, 0]
    for shift in range(depth - 1, -1, -1):
        child = (prefix >> (3 * shift)) & 7
        xyz = [(xyz[i] << 1) | ((child >> (2 - i)) & 1) for i in range(3)]
    return np.asarray(xyz, dtype=float)
def render(report_path, gt_path, candidate_path, out_dir, max_arrows=220):
    report = json.loads(report_path.read_text(encoding="utf-8")); level = max(report["levels"], key=lambda x: x["summary"]["depth"])
    depth = int(level["summary"]["depth"]); frame = report["frame"]; minimum = np.asarray(frame["minMm"], dtype=float); scale = float(frame["sideMm"]) / (1 << depth)
    cells = [c for c in level["candidateCells"] if c["displacementMm"] is not None]; cells.sort(key=lambda c: c["prefix"])
    if len(cells) > max_arrows: cells = [cells[i] for i in np.linspace(0, len(cells)-1, max_arrows, dtype=int)]
    meshes = [(load_obj(gt_path), "#2f73b8", .20), (load_obj(candidate_path), "#777777", .16)]; out_dir.mkdir(parents=True, exist_ok=True); outputs = []
    for name, elev, azim in (("front",10,-90),("top",90,-90),("side",0,0)):
        fig = plt.figure(figsize=(10,10), dpi=160); ax = fig.add_subplot(111, projection="3d")
        for (vertices, faces), colour, alpha in meshes: ax.add_collection3d(Poly3DCollection([[vertices[i] for i in face] for face in faces], facecolor=colour, edgecolor="none", alpha=alpha))
        for cell in cells:
            source = minimum + (decode(int(cell["prefix"]), depth) + .5) * scale; vector = np.asarray(cell["displacementMm"], dtype=float)
            ax.quiver(*source, *vector, color=plt.cm.plasma(float(np.clip(cell["sourceMarginalRatio"],0,1))), linewidth=.7, arrow_length_ratio=.12, alpha=.8)
        ax.set(xlim=(-1,1), ylim=(-1,1), zlim=(-1,1), xlabel="X", ylabel="Y", zlabel="Z"); ax.set_box_aspect((1,1,1))
        ax.set_title("All mapped cells\nGT blue · candidate gray · arrows = candidate → GT (/3 displacement target proxy)"); ax.view_init(elev=elev, azim=azim)
        scalar = plt.cm.ScalarMappable(cmap="plasma", norm=plt.Normalize(0,1)); scalar.set_array([]); fig.colorbar(scalar, ax=ax, shrink=.55, label="source marginal ratio")
        output = out_dir / ("mapping-report-" + name + ".png"); fig.tight_layout(); fig.savefig(output); plt.close(fig); outputs.append(output)
    return outputs
def main():
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument("--report", type=Path, required=True); parser.add_argument("--gt", type=Path, required=True); parser.add_argument("--candidate", type=Path, required=True); parser.add_argument("--out-dir", type=Path, required=True); parser.add_argument("--max-arrows", type=int, default=220)
    args = parser.parse_args()
    if args.max_arrows < 1: parser.error("--max-arrows must be positive")
    for path in render(args.report, args.gt, args.candidate, args.out_dir, args.max_arrows): print(path)
if __name__ == "__main__": main()

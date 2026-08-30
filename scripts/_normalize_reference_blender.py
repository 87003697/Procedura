#!/usr/bin/env python3
"""Convert one supported reference mesh to Procedura's Z-up millimetre STL."""

from __future__ import annotations

import argparse
import io
import json
import math
import os
from pathlib import Path
import struct
import sys
import tempfile
from urllib.parse import unquote, urlparse
import xml.etree.ElementTree as ET
import zipfile

import bpy


Point = tuple[float, float, float]
Triangle = tuple[Point, Point, Point]
Matrix = tuple[tuple[float, float, float, float], ...]

IDENTITY: Matrix = (
    (1.0, 0.0, 0.0, 0.0),
    (0.0, 1.0, 0.0, 0.0),
    (0.0, 0.0, 1.0, 0.0),
    (0.0, 0.0, 0.0, 1.0),
)


def write_binary_stl(path: Path, triangles: list[Triangle]) -> None:
    if not triangles:
        raise ValueError("reference mesh contains no triangles")
    with path.open("wb") as output:
        output.write(b"procedura canonical STL".ljust(80, b" "))
        output.write(struct.pack("<I", len(triangles)))
        for a, b, c in triangles:
            ux, uy, uz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
            vx, vy, vz = c[0] - a[0], c[1] - a[1], c[2] - a[2]
            nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
            length = math.sqrt(nx * nx + ny * ny + nz * nz)
            normal = (0.0, 0.0, 0.0) if length == 0 else (nx / length, ny / length, nz / length)
            output.write(struct.pack("<12fH", *normal, *a, *b, *c, 0))


def gltf_document(path: Path) -> dict[str, object]:
    if path.suffix.lower() == ".gltf":
        return json.loads(path.read_text("utf8"))
    data = path.read_bytes()
    if len(data) < 20 or data[:4] != b"glTF" or struct.unpack_from("<I", data, 4)[0] != 2:
        raise ValueError("GLB must use glTF 2.0")
    offset = 12
    while offset + 8 <= len(data):
        size, kind = struct.unpack_from("<II", data, offset)
        offset += 8
        chunk = data[offset:offset + size]
        offset += size
        if kind == 0x4E4F534A:
            return json.loads(chunk.rstrip(b"\x00 \t\r\n").decode("utf8"))
    raise ValueError("GLB has no JSON chunk")


def rewrite_gltf_identity(path: Path) -> Path:
    """Give every source mesh a short unique importer identity.

    Blender's display names are not a stable source-index mapping: they may be
    truncated or suffixed when names collide. The temporary document keeps all
    source buffers and rewrites only mesh names to bounded unique identities.
    """
    data = path.read_bytes()
    if path.suffix.lower() == ".gltf":
        document = json.loads(data.decode("utf8"))
        chunks: list[tuple[int, bytes]] = []
    else:
        if len(data) < 20 or data[:4] != b"glTF":
            raise ValueError("GLB must use glTF 2.0")
        document = gltf_document(path)
        chunks = []
        offset = 12
        while offset + 8 <= len(data):
            size, kind = struct.unpack_from("<II", data, offset)
            offset += 8
            chunks.append((kind, data[offset:offset + size]))
            offset += size
    meshes = document.get("meshes", [])
    for index, mesh in enumerate(meshes):
        identity = f"__procedura_mesh_{index:08d}"
        mesh["name"] = identity
    temp_fd, temp_name = tempfile.mkstemp(
        suffix=path.suffix,
        prefix=".procedura-gltf-",
    )
    try:
        os.close(temp_fd)
    except Exception:
        Path(temp_name).unlink(missing_ok=True)
        raise
    temp = Path(temp_name)
    try:
        for collection_name in ("buffers", "images"):
            for resource in document.get(collection_name, []):
                uri = resource.get("uri")
                if (
                    not isinstance(uri, str)
                    or uri.startswith("data:")
                    or urlparse(uri).scheme
                    or Path(unquote(uri)).is_absolute()
                ):
                    continue
                resource["uri"] = str((path.parent / unquote(uri)).resolve())
        encoded = json.dumps(document, separators=(",", ":")).encode("utf8")
        if path.suffix.lower() == ".gltf":
            temp.write_bytes(encoded)
        else:
            encoded += b" " * (-len(encoded) % 4)
            binary = next((chunk for kind, chunk in chunks if kind == 0x004E4942), b"")
            binary += b"\0" * (-len(binary) % 4)
            blob = b"glTF" + struct.pack("<II", 2, 12 + 8 + len(encoded) + 8 + len(binary))
            blob += struct.pack("<II", len(encoded), 0x4E4F534A) + encoded
            blob += struct.pack("<II", len(binary), 0x004E4942) + binary
            temp.write_bytes(blob)
    except Exception:
        temp.unlink(missing_ok=True)
        raise
    return temp


def validate_gltf(path: Path) -> set[int]:
    document = gltf_document(path)
    scenes = document.get("scenes", [])
    nodes = document.get("nodes", [])
    meshes = document.get("meshes", [])
    scene_index = document.get("scene", 0)
    if not isinstance(scene_index, int) or scene_index < 0 or scene_index >= len(scenes):
        raise ValueError("glTF default scene index is out of range")
    roots = scenes[scene_index].get("nodes", [])
    reachable: set[int] = set()
    visiting: set[int] = set()

    def visit(node_index: object) -> None:
        if not isinstance(node_index, int) or node_index < 0 or node_index >= len(nodes):
            raise ValueError("glTF default scene node index is out of range")
        if node_index in visiting:
            raise ValueError("glTF default scene contains a node cycle")
        if node_index in reachable:
            return
        visiting.add(node_index)
        node = nodes[node_index]
        mesh_index = node.get("mesh")
        if mesh_index is not None and (not isinstance(mesh_index, int) or mesh_index < 0 or mesh_index >= len(meshes)):
            raise ValueError("glTF default scene mesh index is out of range")
        for child in node.get("children", []):
            visit(child)
        visiting.remove(node_index)
        reachable.add(node_index)

    for root in roots:
        visit(root)
    reachable_meshes = {nodes[index]["mesh"] for index in reachable if "mesh" in nodes[index]}
    for mesh_index in reachable_meshes:
        mesh = meshes[mesh_index]
        for primitive in mesh.get("primitives", []):
            extensions = primitive.get("extensions", {})
            if "KHR_draco_mesh_compression" in extensions:
                raise ValueError("compressed glTF geometry is not supported")
            if primitive.get("mode", 4) != 4:
                raise ValueError("glTF primitive mode must be TRIANGLES")
            if primitive.get("targets"):
                raise ValueError("glTF morph targets are not supported")
            accessor_refs = list(primitive.get("attributes", {}).values())
            if "indices" in primitive:
                accessor_refs.append(primitive["indices"])
            accessors = document.get("accessors", [])
            buffer_views = document.get("bufferViews", [])
            for accessor_index in accessor_refs:
                if not isinstance(accessor_index, int) or accessor_index < 0 or accessor_index >= len(accessors):
                    raise ValueError("glTF default scene accessor index is out of range")
                buffer_view_index = accessors[accessor_index].get("bufferView")
                if buffer_view_index is None:
                    continue
                if not isinstance(buffer_view_index, int) or buffer_view_index < 0 or buffer_view_index >= len(buffer_views):
                    raise ValueError("glTF default scene bufferView index is out of range")
                buffer_extensions = buffer_views[buffer_view_index].get("extensions", {})
                if "EXT_meshopt_compression" in buffer_extensions:
                    raise ValueError("compressed glTF geometry is not supported")
    reachable_skins = {nodes[index]["skin"] for index in reachable if "skin" in nodes[index]}
    for skin_index in reachable_skins:
        if not isinstance(skin_index, int) or skin_index < 0 or skin_index >= len(document.get("skins", [])):
            raise ValueError("glTF default scene skin index is out of range")
        raise ValueError("glTF skinning is not supported")
    for animation in document.get("animations", []):
        for channel in animation.get("channels", []):
            target = channel.get("target", {})
            if target.get("node") in reachable:
                raise ValueError("glTF animation is not supported")
    return {int(index) for index in reachable_meshes}


def blender_triangles(scale: float, allowed_meshes: set[str] | None = None) -> list[Triangle]:
    triangles: list[Triangle] = []
    depsgraph = bpy.context.evaluated_depsgraph_get()
    for instance in depsgraph.object_instances:
        obj = instance.object
        if obj.type != "MESH":
            continue
        if allowed_meshes is not None and not any(
            obj.data.name == name or obj.data.name.startswith(name + ".")
            for name in allowed_meshes
        ):
            continue
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        try:
            mesh.calc_loop_triangles()
            world = instance.matrix_world
            for triangle in mesh.loop_triangles:
                points = []
                for index in triangle.vertices:
                    point = world @ mesh.vertices[index].co
                    points.append((point.x * scale, point.y * scale, point.z * scale))
                triangles.append((points[0], points[1], points[2]))
        finally:
            evaluated.to_mesh_clear()
    return triangles


def convert_with_blender(source: Path, format_name: str) -> list[Triangle]:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    if format_name == "ply":
        bpy.ops.wm.ply_import(filepath=str(source))
        return blender_triangles(1.0)
    allowed_indices = validate_gltf(source)
    importer_source = rewrite_gltf_identity(source)
    allowed_meshes = {
        f"__procedura_mesh_{index:08d}" for index in allowed_indices
    }
    try:
        bpy.ops.import_scene.gltf(filepath=str(importer_source), import_pack_images=False)
    finally:
        importer_source.unlink(missing_ok=True)
    for obj in list(bpy.data.objects):
        if obj.type == "MESH" and not any(
            obj.data.name == name or obj.data.name.startswith(name + ".")
            for name in allowed_meshes
        ):
            bpy.data.objects.remove(obj, do_unlink=True)
    bpy.context.view_layer.update()
    return blender_triangles(1000.0, allowed_meshes)


def matrix_from_3mf(raw: str | None) -> Matrix:
    if raw is None:
        return IDENTITY
    values = [float(value) for value in raw.split()]
    if len(values) != 12:
        raise ValueError("3MF transform must contain 12 numbers")
    a, b, c, d, e, f, g, h, i, j, k, l = values
    return ((a, d, g, j), (b, e, h, k), (c, f, i, l), (0.0, 0.0, 0.0, 1.0))


def multiply(left: Matrix, right: Matrix) -> Matrix:
    return tuple(
        tuple(sum(left[row][step] * right[step][column] for step in range(4)) for column in range(4))
        for row in range(4)
    )


def transform_point(matrix: Matrix, point: Point, scale: float) -> Point:
    x, y, z = point
    return (
        (matrix[0][0] * x + matrix[0][1] * y + matrix[0][2] * z + matrix[0][3]) * scale,
        (matrix[1][0] * x + matrix[1][1] * y + matrix[1][2] * z + matrix[1][3]) * scale,
        (matrix[2][0] * x + matrix[2][1] * y + matrix[2][2] * z + matrix[2][3]) * scale,
    )


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def convert_3mf(source: Path) -> list[Triangle]:
    with zipfile.ZipFile(source) as archive:
        model_names = []
        rels_name = "_rels/.rels"
        if rels_name in archive.namelist():
            rels = ET.fromstring(archive.read(rels_name))
            for relation in rels:
                if relation.attrib.get("Type", "").lower().endswith("/3dmodel"):
                    target = relation.attrib.get("Target", "").lstrip("/")
                    if target in archive.namelist():
                        model_names.append(target)
        if not model_names:
            model_names = [name for name in archive.namelist() if name.lower().startswith("3d/") and name.lower().endswith(".model")]
        if not model_names:
            raise ValueError("3MF archive has no core model")
        if len(set(model_names)) != 1:
            raise ValueError("3MF package must identify exactly one core model")
        model_data = archive.read(model_names[0])
    namespace_declarations = {
        prefix: uri for _, (prefix, uri) in ET.iterparse(io.BytesIO(model_data), events=("start-ns",))
    }
    root = ET.fromstring(model_data)
    required_namespaces: set[str] = set()
    for prefix in root.attrib.get("requiredextensions", "").split():
        namespace = namespace_declarations.get(prefix)
        if namespace is None:
            raise ValueError(f"3MF required extension prefix is not declared: {prefix}")
        required_namespaces.add(namespace)
    unit_scale = {
        "micron": 0.001,
        "millimeter": 1.0,
        "centimeter": 10.0,
        "meter": 1000.0,
        "inch": 25.4,
        "foot": 304.8,
    }.get(root.attrib.get("unit", "millimeter"))
    if unit_scale is None:
        raise ValueError("unsupported 3MF unit")
    namespace = root.tag.split("}", 1)[0].lstrip("{")
    query = {"m": namespace}
    resources = root.find("m:resources", query)
    build = root.find("m:build", query)
    if resources is None or build is None or not list(build):
        raise ValueError("3MF requires resources and build items")
    objects = {element.attrib["id"]: element for element in resources.findall("m:object", query)}
    output: list[Triangle] = []

    def reject_required_extension(element: ET.Element) -> None:
        for current in element.iter():
            if current.tag.startswith("{") and current.tag.split("}", 1)[0][1:] in required_namespaces:
                raise ValueError("3MF required extensions are not supported")
            if any(key.startswith("{") and key.split("}", 1)[0][1:] in required_namespaces for key in current.attrib):
                raise ValueError("3MF required extensions are not supported")

    def emit(object_id: str, matrix: Matrix, active: set[str]) -> None:
        if object_id in active:
            raise ValueError("3MF component cycle")
        element = objects.get(object_id)
        if element is None:
            raise ValueError(f"3MF object not found: {object_id}")
        reject_required_extension(element)
        if any(local_name(child.tag) in {"beamlattice", "beam", "balls", "ball"} for child in element.iter()):
            raise ValueError("3MF beam or lattice geometry is not supported")
        mesh = element.find("m:mesh", query)
        components = element.find("m:components", query)
        if mesh is not None:
            vertices_element = mesh.find("m:vertices", query)
            triangles_element = mesh.find("m:triangles", query)
            if vertices_element is None or triangles_element is None:
                raise ValueError("3MF mesh requires vertices and triangles")
            vertices = [
                (float(vertex.attrib["x"]), float(vertex.attrib["y"]), float(vertex.attrib["z"]))
                for vertex in vertices_element.findall("m:vertex", query)
            ]
            for triangle in triangles_element.findall("m:triangle", query):
                indices = [int(triangle.attrib[name]) for name in ("v1", "v2", "v3")]
                output.append(tuple(transform_point(matrix, vertices[index], unit_scale) for index in indices))
            return
        if components is None:
            raise ValueError(f"3MF object has no mesh or components: {object_id}")
        next_active = active | {object_id}
        for component in components.findall("m:component", query):
            child = matrix_from_3mf(component.attrib.get("transform"))
            emit(component.attrib["objectid"], multiply(matrix, child), next_active)

    reject_required_extension(build)
    for item in build.findall("m:item", query):
        emit(item.attrib["objectid"], matrix_from_3mf(item.attrib.get("transform")), set())
    return output


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--format", required=True, choices=("ply", "glb", "gltf", "3mf"))
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    triangles = convert_3mf(args.input) if args.format == "3mf" else convert_with_blender(args.input, args.format)
    write_binary_stl(args.output, triangles)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(2)

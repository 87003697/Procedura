"""Shared Cycles GPU device selection for the scripts/_render_*.py renderers.

Imported by each renderer rather than duplicated, because getting this wrong is
silent: Cycles happily renders on the CPU and the only symptom is that a frame
takes 7x longer.

Three things the previous per-script code got wrong:

  1. It picked the backend by assigning `compute_device_type` in a try/except and
     breaking on the first assignment that did not raise. But every CUDA build
     carries the whole enum ('NONE','CUDA','OPTIX','HIP','ONEAPI'), so assigning
     "OPTIX" succeeds even on a machine with no OptiX-capable device — and the
     loop stops there, leaving zero usable devices and a silent CPU render. The
     backend has to be chosen by whether it actually YIELDS a GPU device.

  2. It enabled every device with `d.use = True`, which includes the CPU entry.
     That makes Cycles render CPU+GPU hybrid, and measured on an RTX 3090 the CPU
     tiles hold the frame back: 59s hybrid vs 48s GPU-only at 2048/500 on a
     14-mesh assembly. GPU-only is both what was asked for and faster.

  3. It never said which device it chose, so a fallback to CPU was invisible.
"""

# Ordered by preference. OptiX uses the RT cores on RTX hardware and is the
# fastest path for these scenes; the rest are fallbacks for other vendors.
_BACKENDS = ("OPTIX", "CUDA", "HIP", "ONEAPI", "METAL")


def enable_gpu(scene, want_gpu=True, log=print):
    """Point Cycles at the GPU. Returns True if a GPU device is actually in use.

    Enables only non-CPU devices. Falls back to CPU with a LOUD message when a
    GPU was requested but none is usable, so a slow render is never a mystery.
    """
    if not want_gpu:
        scene.cycles.device = "CPU"
        log("[render] device: CPU (GPU not requested)")
        return False

    try:
        import bpy
        prefs = bpy.context.preferences.addons["cycles"].preferences
    except Exception as e:                                    # no cycles addon
        scene.cycles.device = "CPU"
        log(f"[render] WARNING: cannot reach Cycles preferences ({e}); rendering on CPU")
        return False

    chosen, gpus = None, []
    for backend in _BACKENDS:
        try:
            prefs.compute_device_type = backend
        except TypeError:
            continue                                          # not in this build's enum
        try:
            prefs.get_devices()
        except Exception:
            pass
        found = [d for d in prefs.devices if d.type == backend]
        if found:
            chosen, gpus = backend, found
            break

    if not chosen:
        scene.cycles.device = "CPU"
        log("[render] WARNING: --gpu requested but Cycles found no GPU device; "
            "rendering on CPU (expect ~7x longer)")
        return False

    # GPU only: leaving the CPU device enabled measurably slows the render.
    for d in prefs.devices:
        d.use = (d.type == chosen)
    scene.cycles.device = "GPU"
    log(f"[render] device: {chosen} — {', '.join(sorted({d.name for d in gpus}))}")
    return True

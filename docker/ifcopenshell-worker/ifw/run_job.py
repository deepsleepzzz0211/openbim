"""One conversion per process (crash isolation, ticket 09).

Usage: python -m ifw.run_job '<request-json>'
Protocol on stdout (one JSON line per event, read by worker.py):
  {"event":"progress","percent":n}
  {"event":"result","ok":true,"stats":{...},"schema":"IFC4"} |
  {"event":"result","ok":false,"code":"...","message":"..."}
"""
import json
import os
import sys
import traceback

from .pipeline import ConversionError, convert_document


def make_engine():
    if os.environ.get("IFW_ENGINE") == "stub":
        # protocol-testing engine: synthesizes a tiny document for any input
        from .engines.stub import synthetic_document

        class _StubEngine:
            def open(self, path: str):
                return synthetic_document()

        return _StubEngine()
    from .engines.ifcopenshell_engine import IfcOpenShellEngine

    threads = int(os.environ.get("IFC_WORKER_THREADS", "4"))
    return IfcOpenShellEngine(threads=threads)


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main() -> int:
    try:
        req = json.loads(sys.argv[1])
    except Exception:
        emit({"event": "result", "ok": False, "code": "BAD_REQUEST", "message": "request json unreadable"})
        return 2
    glb_path = req.get("glb_path")
    meta_path = req.get("meta_path")
    input_path = req.get("input_path")
    if not glb_path or not meta_path or not input_path:
        emit({"event": "result", "ok": False, "code": "BAD_REQUEST", "message": "input_path, glb_path and meta_path are required"})
        return 2
    try:
        os.makedirs(os.path.dirname(glb_path) or ".", exist_ok=True)
        os.makedirs(os.path.dirname(meta_path) or ".", exist_ok=True)
        engine = make_engine()
        doc = engine.open(input_path)
        meta = convert_document(
            doc,
            glb_path,
            meta_path,
            chunking=req.get("chunking"),
            on_progress=lambda pct: emit({"event": "progress", "percent": pct}),
        )
        emit({"event": "result", "ok": True, "stats": meta["stats"], "schema": meta["schema"]})
        return 0
    except ConversionError as err:
        emit({"event": "result", "ok": False, "code": err.code, "message": str(err)})
        return 1
    except Exception as err:  # noqa: BLE001 — the boundary of a one-shot process
        traceback.print_exc(file=sys.stderr)
        emit({"event": "result", "ok": False, "code": "NATIVE_CRASH", "message": str(err)})
        return 1


if __name__ == "__main__":
    sys.exit(main())

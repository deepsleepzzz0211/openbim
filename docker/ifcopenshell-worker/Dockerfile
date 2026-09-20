# Native IfcOpenShell conversion worker (ticket 09).
# Separate container => separate process => LGPL boundary with the API.
#   docker build -f docker/ifcopenshell-worker/Dockerfile -t openbim-hub-ifc-worker .
FROM python:3.11-slim

# ifcopenshell publishes manylinux wheels with the OCC/OCP geometry kernel.
RUN pip install --no-cache-dir "ifcopenshell>=0.7,<0.9"

WORKDIR /app
COPY docker/ifcopenshell-worker /app

ENV HOST=0.0.0.0 \
    PORT=8090 \
    IFC_WORKER_THREADS=4 \
    MAX_CONCURRENT_JOBS=1

EXPOSE 8090
# Non-root: the container only needs the shared blob volume mounted at /data.
RUN useradd --create-home worker
USER worker
CMD ["python", "worker.py"]

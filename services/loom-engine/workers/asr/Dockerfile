# ASR worker (compose profile "asr"): faster-whisper on CPU (int8). The model is
# supplied as a read-only, operator-verified revision/hash-locked model directory.
# Build never downloads a floating model. Missing/invalid lock fails closed.
FROM python:3.12-slim@sha256:a0f57064cbdcd6285fa45f51237ab0b35ea8ebaed06a1f5973e89e19dfb86704
ENV ASR_MODEL_DIR=/models ASR_MODEL_MANIFEST=/models/model-lock.json HF_HUB_OFFLINE=1
WORKDIR /app
COPY requirements.txt requirements-model.txt ./
RUN pip install --no-cache-dir -r requirements.txt -r requirements-model.txt
COPY server.py .
USER 65534:65534
EXPOSE 8797
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8797/healthz')"
CMD ["python", "server.py"]

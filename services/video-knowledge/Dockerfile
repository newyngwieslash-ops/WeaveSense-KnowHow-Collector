FROM python:3.12-slim@sha256:a0f57064cbdcd6285fa45f51237ab0b35ea8ebaed06a1f5973e89e19dfb86704
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data && chown 65534:65534 /data
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY core.py dtk.py media.py runtime.py synthesis.py server.py ./
USER 65534:65534
ENV VIDEO_EXECUTION_DB=/data/executions.sqlite3 VIDEO_PORT=8799
EXPOSE 8799
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8799/healthz')"
CMD ["python", "server.py"]

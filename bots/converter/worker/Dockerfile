# syntax=docker/dockerfile:1.7
# Wanger Converter worker — multi-stage, non-root, healthchecked.
#   docker build -t wanger-converter-worker .
#   docker build --target test .        # runs the test suite inside the image's environment
# An optional BuildKit secret `extra_ca` (a PEM file) is trusted during the build only — for builds behind
# a TLS-intercepting proxy; it never ends up in the image.
ARG PYTHON_IMAGE=python:3.12-slim-bookworm

FROM ${PYTHON_IMAGE} AS base
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
# FriBiDi is loaded by Pillow's bundled RAQM at runtime (Persian text); tini reaps orphaned processes;
# Tesseract 5 with the spec's languages (fas eng ara deu fra spa tur) + OSD (C5).
RUN --mount=type=secret,id=extra_ca,required=false,mode=0444 \
    sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
 && CA=""; if [ -s /run/secrets/extra_ca ]; then CA="-o Acquire::https::CAInfo=/run/secrets/extra_ca"; fi \
 && apt-get $CA update \
 && apt-get $CA install -y --no-install-recommends libfribidi0 tini tesseract-ocr tesseract-ocr-osd \
      tesseract-ocr-fas tesseract-ocr-eng tesseract-ocr-ara tesseract-ocr-deu tesseract-ocr-fra tesseract-ocr-spa tesseract-ocr-tur \
 && rm -rf /var/lib/apt/lists/*
# The Debian (fast) models: on the benchmark they were as accurate as tessdata_best on average,
# better on short lines and 2× faster (docs/OCR_BENCHMARK.md). tessdata_best stays optional:
# mount a directory with fas/ara/eng.traineddata and set TESSDATA_BEST_DIR.

FROM base AS build
RUN python -m venv /opt/venv
COPY requirements.txt /tmp/requirements.txt
RUN --mount=type=secret,id=extra_ca,required=false,mode=0444 \
    if [ -s /run/secrets/extra_ca ]; then export PIP_CERT=/run/secrets/extra_ca; fi \
 && /opt/venv/bin/pip install -r /tmp/requirements.txt

FROM build AS test
COPY requirements-dev.txt /tmp/requirements-dev.txt
RUN --mount=type=secret,id=extra_ca,required=false,mode=0444 \
    if [ -s /run/secrets/extra_ca ]; then export PIP_CERT=/run/secrets/extra_ca; fi \
 && /opt/venv/bin/pip install -r /tmp/requirements-dev.txt
WORKDIR /app
COPY pyproject.toml ./
COPY app ./app
COPY fonts ./fonts
COPY tests ./tests
RUN /opt/venv/bin/ruff check app tests && /opt/venv/bin/python -m pytest -q -p no:cacheprovider

FROM base AS runtime
RUN useradd --system --uid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin wanger \
 && mkdir -p /data /tmp/wanger && chown wanger:wanger /data /tmp/wanger && chmod 700 /data /tmp/wanger
COPY --from=build /opt/venv /opt/venv
WORKDIR /app
COPY app ./app
COPY fonts ./fonts
ENV PATH=/opt/venv/bin:$PATH DATA_DIR=/data TMP_DIR=/tmp/wanger
USER wanger
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["python", "-c", "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/readyz', timeout=4).status == 200 else 1)"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["uvicorn", "app.main:app_factory", "--factory", "--host", "0.0.0.0", "--port", "8080", "--workers", "1", "--no-server-header"]

# Option B (later): the same code as a long-running worker. Option A (now) runs on GitHub Actions.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app
RUN useradd --create-home --uid 10001 app

COPY pyproject.toml README.md ./
COPY src ./src
RUN pip install .

COPY alembic.ini ./
COPY migrations ./migrations
COPY config ./config
COPY prompts ./prompts

USER app
ENTRYPOINT ["python", "-m", "wanger_news"]
CMD ["worker", "--trigger", "worker"]

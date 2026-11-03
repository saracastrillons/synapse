# Build from the repository root:  docker build -f backend/Dockerfile .
FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/app ./app
COPY backend/tests ./tests
COPY backend/pyproject.toml .
# the OSM-derived dataset seeds the PostGIS tables on first start
COPY frontend/public/data/medellin.json /data/medellin.json
ENV DATA_PATH=/data/medellin.json

RUN useradd --create-home synapse
USER synapse

EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=3s --retries=5 CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/api/health')"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]

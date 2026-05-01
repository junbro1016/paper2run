FROM python:3.12-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY . .

ENV HOST=0.0.0.0
ENV PORT=8787

EXPOSE 8787

CMD ["python3", "apps/mapping-api/server.py"]

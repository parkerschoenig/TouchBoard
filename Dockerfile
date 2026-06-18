FROM python:3.12-slim

# iputils-ping lets the ping widget do ICMP checks for bare IPs
RUN apt-get update \
    && apt-get install -y --no-install-recommends iputils-ping \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend ./backend
COPY frontend ./frontend

ENV TOUCHBOARD_DB=/data/touchboard.db
VOLUME ["/data"]
EXPOSE 8011

CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8011"]

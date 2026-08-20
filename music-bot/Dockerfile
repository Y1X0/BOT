# Voice-chat music bot (Python + py-tgcalls). Needs ffmpeg for audio streaming.
FROM python:3.11-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1

# ffmpeg: py-tgcalls streams audio through it. (NTgCalls WebRTC ships as a
# prebuilt wheel with py-tgcalls, so no extra system libs are needed.)
RUN apt-get update -y \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

CMD ["python", "main.py"]

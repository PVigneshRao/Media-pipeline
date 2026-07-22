FROM node:18-bullseye-slim

# Python + system deps for OpenCV and Tesseract OCR.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip \
    tesseract-ocr \
    libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY src/analysis/requirements.txt ./src/analysis/requirements.txt
RUN pip3 install --no-cache-dir -r src/analysis/requirements.txt

COPY . .

RUN mkdir -p storage/uploads

ENV PYTHON_BIN=python3
EXPOSE 4000

CMD ["node", "src/server.js"]

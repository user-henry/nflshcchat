FROM python:3.11-slim

WORKDIR /app

# Copy and install dependencies FIRST (cached layer)
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy entire app (cached)
COPY . .

# Railway sets PORT env var; Flask needs it
EXPOSE 19000
ENV PORT=19000
ENV FLASK_ENV=production

# Start command
CMD ["python3", "backend/app.py"]
FROM python:3.11-slim

WORKDIR /app

# Copy and install dependencies
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy entire app
COPY . .

# Railway sets PORT env var
ENV PORT=19000
ENV FLASK_ENV=production
EXPOSE 19000

# Use absolute path, no 'cd' needed
CMD ["python3", "/app/backend/app.py"]
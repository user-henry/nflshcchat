FROM python:3.11-slim

WORKDIR /app

# Copy and install dependencies
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy entire app
COPY . .

# Railway sets PORT env var; map it to STAR_BACKEND_PORT for app.py
ENV PORT=19000
ENV STAR_BACKEND_PORT=${PORT}
ENV FLASK_ENV=production

# Security: strong secrets for production mode
ENV FLASK_SECRET_KEY=staroffice-nflshcchat-railway-deploy-2025-secret-key
ENV STAR_OFFICE_SECRET=staroffice-nflshcchat-railway-deploy-2025-strong-secret
ENV ASSET_DRAWER_PASS=nflshc2025

EXPOSE 19000

CMD ["python3", "/app/backend/app.py"]
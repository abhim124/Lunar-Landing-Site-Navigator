# Backend container for a Hugging Face Docker Space (also works on Fly.io / Railway / Cloud Run).
# The Space must contain: Dockerfile, README.md (Space settings), requirements.txt, app/, data/.
# scripts/deploy_hf_space.py assembles and uploads exactly that, never backend/.env.
FROM python:3.14-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# Hugging Face runs containers as uid 1000.
RUN useradd -m -u 1000 user
WORKDIR /home/user/app

# rasterio's bundled GDAL needs libexpat, which the slim image leaves out.
RUN apt-get update && apt-get install -y --no-install-recommends libexpat1 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY --chown=user app ./app
# ≈1.3 GB of NASA rasters, grids and SPICE kernels (see backend/README.md); data/cache stays writable.
COPY --chown=user data ./data

USER user
EXPOSE 7860
# NASA_API_KEY comes from the host's secrets; CORS_ORIGINS from its variables.
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-7860} --proxy-headers --forwarded-allow-ips '*'"]

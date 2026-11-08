FROM python:3.12-alpine
COPY m00d_sync.py /app/m00d_sync.py
ENV PYTHONUNBUFFERED=1 \
    M00D_HOST=0.0.0.0 \
    M00D_PORT=8787 \
    M00D_DATA_DIR=/data
EXPOSE 8787
CMD ["python3", "/app/m00d_sync.py"]

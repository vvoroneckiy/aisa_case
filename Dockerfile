FROM python:3.11-slim

WORKDIR /app

# Копируем зависимости
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Копируем весь код приложения
COPY app/ ./app/
COPY static/ ./static/
COPY templates/ ./templates/

# Создаём точку монтирования для БД
RUN mkdir -p /data

# Запускаем приложение через uvicorn
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
FROM python:3.11-slim
WORKDIR /app
COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir .
ENTRYPOINT ["python", "-m", "one_mail_agg.main"]
CMD ["/app/config.json"]